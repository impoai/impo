package ai.impo.nativebridge

import android.content.Context
import ai.impo.client.*
import java.io.File
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable internal data class NativeDeviceReceipt(
    val accountId: String, val invocationId: String, val toolName: String, val inputHash: String,
    val result: DeviceResult,
)

/** A native read has one durable result for its account/device/invocation/execution identity. */
internal class NativeReceiptStore(root: File, private val accountId: String) {
    private val directory = accountDirectory(root, accountId)
    private fun file(id: String) = File(directory, "${sha256(id.toByteArray())}.json")
    @Synchronized fun load(invocation: DeviceInvocation, claim: ToolClaim): DeviceResult? {
        val file = file(invocation.invocationId)
        if (!file.exists()) return null
        val receipt = nativeJson.decodeFromString<NativeDeviceReceipt>(file.readText())
        require(receipt.accountId == accountId && receipt.invocationId == invocation.invocationId &&
            receipt.toolName == invocation.toolName && receipt.inputHash == inputHash(invocation) &&
            receipt.result.deviceId == invocation.deviceId && receipt.result.executionId == claim.executionId) { "native_receipt_conflict" }
        return receipt.result
    }
    @Synchronized fun save(invocation: DeviceInvocation, claim: ToolClaim, result: DeviceResult) {
        require(result.deviceId == invocation.deviceId && result.executionId == claim.executionId)
        val previous = load(invocation, claim)
        require(previous == null || previous == result) { "native_receipt_conflict" }
        if (previous == null) atomicWrite(file(invocation.invocationId), nativeJson.encodeToString(
            NativeDeviceReceipt(accountId, invocation.invocationId, invocation.toolName, inputHash(invocation), result)).toByteArray())
    }
    private fun inputHash(invocation: DeviceInvocation) = sha256(canonicalJson(invocation.input).toString().toByteArray())
}

/** Polls owned pending work only while the UI is active; SSE replay never authorizes a native read. */
class DeviceCoordinator internal constructor(context: Context, private val lock: Mutex) {
    constructor(context: Context) : this(context, Mutex())
    private val app = context.applicationContext
    private val adapter = DeviceDataAdapter(app)
    private val preferences = app.getSharedPreferences("native_devices", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    private var registeredAccount: NativeAccount? = null
    private var registeredTools: List<String>? = null
    @Volatile private var identity: Pair<NativeAccount, String>? = null
    private val mutableDeviceId = MutableStateFlow<String?>(null)
    val deviceId: StateFlow<String?> = mutableDeviceId
    fun deviceIdFor(accountId: String): String? = identity?.takeIf {
        it.first.accountId == accountId && NativeBridge.account() === it.first
    }?.second
    private val mutableError = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = mutableError
    private val installationId: String = preferences.getString("installationId", null) ?: UUID.randomUUID().toString().also {
        check(preferences.edit().putString("installationId", it).commit())
    }

    suspend fun configure(calendarEnabled: Boolean, healthEnabled: Boolean, contactsEnabled: Boolean = false) {
        currentCoroutineContext().ensureActive()
        val account = NativeBridge.account() ?: run {
            lock.withLock { if (NativeBridge.account() == null) clearIdentity() }
            return
        }
        val key = sha256(account.accountId.toByteArray())
        // A pending invocation holds lock across network and provider reads. Publish
        // revocation before waiting for it so its pre-submit recheck sees the new opt-in.
        check(preferences.edit().putBoolean("calendar_$key", calendarEnabled).putBoolean("health_$key", healthEnabled)
            .putBoolean("contacts_$key", contactsEnabled).commit())
        lock.withLock {
            requireCurrent(account)
            synchronizeRegistration(account, force = true)
        }
    }

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (isActive) {
                try { pollOnce() }
                catch (_: AccountChangedException) { clearIdentity() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { mutableError.value = "Device connections couldn't refresh. They will retry." }
                delay(3000)
            }
        }
    }
    fun stop() { loop?.cancel(); loop = null }

    suspend fun pollOnce() = lock.withLock {
        val account = NativeBridge.account() ?: run { clearIdentity(); return@withLock }
        synchronizeRegistration(account)
        val id = mutableDeviceId.value ?: return@withLock
        if (registeredTools.isNullOrEmpty()) return@withLock
        val receipts = NativeReceiptStore(File(app.filesDir, "native_receipts"), account.accountId)
        val pending = account.api.pendingDeviceInvocations(id)
        for (invocation in pending) {
            currentCoroutineContext().ensureActive()
            requireCurrent(account)
            if (invocation.deviceId != id || Instant.parse(invocation.expiresAt) <= Instant.now()) continue
            val tools = currentTools(account)
            if (invocation.toolName !in tools) continue
            val claim = account.api.claimDeviceInvocation(invocation.invocationId, id)
            requireCurrent(account)
            if (Instant.parse(claim.expiresAt) <= Instant.now()) continue
            if (invocation.toolName !in currentTools(account)) continue
            var result = receipts.load(invocation, claim)
            if (result == null) {
                result = try {
                    val output = adapter.execute(invocation.toolName, invocation.input)
                    DeviceResult(id, claim.executionId, true, output = output)
                } catch (cancelled: CancellationException) { throw cancelled }
                  catch (failure: Exception) {
                    val code = failure.message?.takeIf { it.matches(Regex("[a-z_]{1,80}")) } ?: "native_read_failed"
                    DeviceResult(id, claim.executionId, false, error = code)
                }
                requireCurrent(account)
                receipts.save(invocation, claim, result)
            }
            // Saved receipts never grant access after the user revokes the capability.
            requireCurrent(account)
            if (invocation.toolName !in currentTools(account)) continue
            check(account.api.submitDeviceResult(invocation.invocationId, result).accepted)
        }
        mutableError.value = null
    }

    private suspend fun synchronizeRegistration(account: NativeAccount, force: Boolean = false) {
        if (registeredAccount !== account) clearIdentity()
        val tools = currentTools(account)
        if (!force && registeredAccount === account && registeredTools == tools && mutableDeviceId.value != null) return
        val registered = account.api.registerDevice(installationId, tools)
        requireCurrent(account)
        registeredAccount = account; registeredTools = tools; mutableDeviceId.value = registered.deviceId
        identity = account to registered.deviceId
        mutableError.value = null
    }
    private suspend fun currentTools(account: NativeAccount): List<String> {
        requireCurrent(account)
        val key = sha256(account.accountId.toByteArray())
        val tools = adapter.enabledTools(preferences.getBoolean("calendar_$key", false), preferences.getBoolean("health_$key", false),
            preferences.getBoolean("contacts_$key", false))
        requireCurrent(account)
        return tools + ClientAction.capabilities
    }
    private fun requireCurrent(account: NativeAccount) { if (NativeBridge.account() !== account) throw AccountChangedException() }
    private fun clearIdentity() { identity = null; registeredAccount = null; registeredTools = null; mutableDeviceId.value = null }
}
