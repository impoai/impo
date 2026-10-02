package ai.impo.data

import ai.impo.client.AccountChangedException
import ai.impo.client.AccountProfile
import ai.impo.client.ImpoClient
import ai.impo.client.ProfileUpdate
import ai.impo.client.BriefSettings
import ai.impo.client.BriefSlot
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.ZoneId
import java.util.Locale

internal interface ProfileApi {
    suspend fun get(): AccountProfile
    suspend fun update(value: ProfileUpdate): AccountProfile
    suspend fun briefSettings(): BriefSettings?
    suspend fun updateBriefSettings(value: BriefSettings): BriefSettings
}
internal class HttpProfileApi(private val client: ImpoClient) : ProfileApi {
    override suspend fun get() = client.profile()
    override suspend fun update(value: ProfileUpdate) = client.updateProfile(value)
    override suspend fun briefSettings() = client.briefSettings()
    override suspend fun updateBriefSettings(value: BriefSettings) = client.updateBriefSettings(value)
}
internal data class AccountProfileState(
    val settings: UserSettings = UserSettings(), val loaded: Boolean = false,
    val busy: Boolean = false, val error: String? = null, val localLoaded: Boolean = false,
)

/** Durable local edits belong to one account; every completion also belongs to one login. */
internal class AccountProfileSession(
    private val accountId: String,
    private val preferences: ProfilePreferences,
    private val api: ProfileApi,
    private val isCurrent: () -> Boolean,
    private val fallbackName: String = "",
    private val development: Boolean = false,
) {
    private val lock = Mutex()
    private val mutable = MutableStateFlow(AccountProfileState())
    val state = mutable.asStateFlow()

    suspend fun restore() = lock.withLock {
        checkCurrent()
        publish(mutable.value.copy(busy = true, error = null))
        try {
            val cached = preferences.read(accountId)
            checkCurrent()
            publish(AccountProfileState(cached.settings, cached.settings.onboarded || development, busy = true, localLoaded = true))
            synchronize(cached)
            val remote = api.get()
            checkCurrent()
            val updated = updateCache { it.copy(settings = merge(it.settings, remote)) }
            publish(AccountProfileState(updated.settings, loaded = true, busy = true, localLoaded = true))
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (failure: Exception) { publish(mutable.value.copy(error = failure.message ?: "Couldn't restore your account. Please try again.")) }
        finally { if (isCurrent()) publish(mutable.value.copy(busy = false)) }
    }

    suspend fun save(value: UserSettings, baseline: UserSettings = mutable.value.settings): Boolean {
        // Native consent and upload policies are local. A profile request must
        // never delay applying a newer policy, particularly a revocation.
        val policyChanged = value.wifiOnly != baseline.wifiOnly || value.recordingLocation != baseline.recordingLocation ||
            value.calendarEnabled != baseline.calendarEnabled || value.healthEnabled != baseline.healthEnabled || value.contactsEnabled != baseline.contactsEnabled
        val profileChanged = value.assistantName != baseline.assistantName || value.displayName != baseline.displayName ||
            value.mode != baseline.mode || value.avatar != baseline.avatar || (value.onboarded && !baseline.onboarded)
        if (policyChanged && !profileChanged) {
            checkCurrent()
            return try {
                val cached = updateCache { previous -> previous.copy(settings = previous.settings.withPolicies(value, baseline)) }
                publish(mutable.value.copy(settings = cached.settings, localLoaded = true))
                true
            } catch (cancelled: CancellationException) { throw cancelled }
              catch (failure: Exception) { publish(mutable.value.copy(error = failure.message ?: "Couldn't save your preferences.")); false }
        }
        return lock.withLock {
        checkCurrent()
        publish(mutable.value.copy(busy = true, error = null))
        try {
            val cached = updateCache { previous ->
                // A queued checkbox edit must not undo an earlier name edit
                // just because both UI events were drawn from the same snapshot.
                val changed = previous.settings.copy(
                    assistantName = value.assistantName.takeIf { it != baseline.assistantName } ?: previous.settings.assistantName,
                    displayName = value.displayName.takeIf { it != baseline.displayName } ?: previous.settings.displayName,
                    mode = value.mode.takeIf { it != baseline.mode } ?: previous.settings.mode,
                    avatar = value.avatar.takeIf { it != baseline.avatar } ?: previous.settings.avatar,
                    onboarded = previous.settings.onboarded || value.onboarded,
                ).withPolicies(value, baseline)
                val next = changed.copy(
                    assistantName = changed.assistantName.trim().ifEmpty { "Momo" }.take(30),
                    displayName = changed.displayName.trim().take(100),
                    avatar = changed.avatar.takeIf { it in 0..5 } ?: previous.settings.avatar,
                )
                val completing = next.onboarded && !previous.settings.onboarded
                val patch = ProfileUpdate(
                    assistantName = next.assistantName.takeIf { completing || it != previous.settings.assistantName } ?: previous.pending?.assistantName,
                    avatarIndex = next.avatar.takeIf { completing || it != previous.settings.avatar } ?: previous.pending?.avatarIndex,
                    mode = next.mode.takeIf { it != previous.settings.mode } ?: previous.pending?.mode,
                    onboarded = true.takeIf { completing || previous.pending?.onboarded == true },
                ).takeUnless { it.assistantName == null && it.avatarIndex == null && it.onboarded == null && it.mode == null }
                ProfileCache(next, patch, next.displayName.takeIf { completing || it != previous.settings.displayName } ?: previous.pendingDisplayName)
            }
            // Local persistence precedes HTTP, including onboarding completion.
            publish(AccountProfileState(cached.settings, loaded = true, busy = true, localLoaded = true))
            synchronize(cached)
            true
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (failure: Exception) { publish(mutable.value.copy(error = failure.message ?: "Your changes are saved on this device and will retry.")); false }
        finally { if (isCurrent()) publish(mutable.value.copy(busy = false)) }
        }
    }

    private fun UserSettings.withPolicies(value: UserSettings, baseline: UserSettings) = copy(
        wifiOnly = if (value.wifiOnly != baseline.wifiOnly) value.wifiOnly else wifiOnly,
        recordingLocation = if (value.recordingLocation != baseline.recordingLocation) value.recordingLocation else recordingLocation,
        calendarEnabled = if (value.calendarEnabled != baseline.calendarEnabled) value.calendarEnabled else calendarEnabled,
        healthEnabled = if (value.healthEnabled != baseline.healthEnabled) value.healthEnabled else healthEnabled,
        contactsEnabled = if (value.contactsEnabled != baseline.contactsEnabled) value.contactsEnabled else contactsEnabled,
    )

    private suspend fun synchronize(saved: ProfileCache) {
        saved.pending?.let { pending ->
            val remote = api.update(pending)
            checkCurrent()
            val updated = updateCache { cached ->
                if (cached.pending == pending) cached.copy(settings = merge(cached.settings, remote).copy(displayName = cached.settings.displayName), pending = null) else cached
            }
            publish(AccountProfileState(updated.settings, loaded = true, busy = true, localLoaded = true))
        }
        saved.pendingDisplayName?.let { name ->
            val previous = api.briefSettings()
            checkCurrent()
            val settings = previous ?: BriefSettings(ZoneId.systemDefault().id, Locale.getDefault().toLanguageTag(),
                slots = listOf(BriefSlot("morning", "Morning Brief", 8, true), BriefSlot("midday", "Midday Brief", 13, true), BriefSlot("evening", "Evening Brief", 20, true)))
            val remote = api.updateBriefSettings(settings.copy(displayName = name))
            checkCurrent()
            val updated = updateCache { cached ->
                if (cached.pendingDisplayName == name) cached.copy(settings = cached.settings.copy(displayName = remote.displayName), pendingDisplayName = null) else cached
            }
            publish(AccountProfileState(updated.settings, loaded = true, busy = true, localLoaded = true))
        }
    }

    private fun merge(local: UserSettings, remote: AccountProfile) = local.copy(
        onboarded = local.onboarded || remote.onboarded,
        mode = remote.mode?.takeIf { it in setOf("Balanced", "Power") } ?: local.mode,
        assistantName = remote.assistantName?.trim()?.takeIf { it.isNotEmpty() }?.take(30) ?: local.assistantName,
        displayName = remote.displayName?.trim()?.takeIf { it.isNotEmpty() }
            ?: local.displayName.ifBlank { fallbackName.trim().take(100) },
        // iOS custom photos (index 6) are device-local and are not transferable.
        avatar = remote.avatarIndex?.takeIf { it in 0..5 } ?: local.avatar,
    )

    private suspend fun updateCache(change: (ProfileCache) -> ProfileCache): ProfileCache {
        val context = currentCoroutineContext()
        return preferences.update(accountId) { cached ->
            context.ensureActive()
            if (!isCurrent()) throw AccountChangedException()
            change(cached)
        }.also { checkCurrent() }
    }
    private suspend fun checkCurrent() {
        currentCoroutineContext().ensureActive()
        if (!isCurrent()) throw AccountChangedException()
    }
    private fun publish(value: AccountProfileState) { if (isCurrent()) mutable.value = value }
}
