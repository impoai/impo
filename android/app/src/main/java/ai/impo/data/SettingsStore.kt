package ai.impo.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import ai.impo.client.ProtocolJson
import ai.impo.client.ProfileUpdate
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.intOrNull
import java.security.MessageDigest

private val Context.settingsDataStore by preferencesDataStore("impo_settings")
@Serializable data class UserSettings(
    val displayName: String = "", val assistantName: String = "Momo", val avatar: Int = 3,
    val mode: String = "Balanced",
    val onboarded: Boolean = false, val wifiOnly: Boolean = false, val recordingLocation: Boolean = false,
    val calendarEnabled: Boolean = false, val healthEnabled: Boolean = false, val contactsEnabled: Boolean = false,
)
@Serializable data class ProfileCache(val settings: UserSettings = UserSettings(), val pending: ProfileUpdate? = null, val pendingDisplayName: String? = null)
@Serializable data class PendingAccountDeletion(val accountId: String, val baseUrl: String, val development: Boolean, val challenge: ai.impo.client.AccountDeletionChallenge)
@Serializable data class SavedAccountDeletion(val accountId: String, val baseUrl: String, val development: Boolean, val receipt: ai.impo.client.AccountDeletionReceipt, val localCleanupPending: Boolean = true)
interface ProfilePreferences {
    suspend fun read(account: String): ProfileCache
    suspend fun update(account: String, change: (ProfileCache) -> ProfileCache): ProfileCache
}
/** v1 Android avatar indices differed from the shared iOS/server indices. */
internal fun decodeProfileCache(current: String?, legacy: String?): ProfileCache = when {
    current != null -> ProtocolJson.decodeFromString<ProfileCache>(current)
    legacy != null -> ProtocolJson.decodeFromString<UserSettings>(legacy).let { old ->
        val oldAvatar = ProtocolJson.parseToJsonElement(legacy).jsonObject["avatar"]?.jsonPrimitive?.intOrNull ?: 0
        ProfileCache(old.copy(avatar = when (oldAvatar) { 0 -> 3; 1 -> 0; 2 -> 1; 3 -> 2; else -> oldAvatar }))
    }
    else -> ProfileCache()
}
fun accountScope(id: String): String = MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).joinToString("") { "%02x".format(it) }
class SettingsStore(private val context: Context) : ProfilePreferences {
    private val deletedKey = stringSetPreferencesKey("deleted_account_ids")
    private val pendingDeletionKey = stringPreferencesKey("account_deletion_pending")
    val deletedAccounts = context.settingsDataStore.data.map { it[deletedKey].orEmpty() }
    suspend fun pendingDeletion(): PendingAccountDeletion? = context.settingsDataStore.data.first()[pendingDeletionKey]?.let { ProtocolJson.decodeFromString<PendingAccountDeletion>(it) }
    suspend fun savePendingDeletion(value: PendingAccountDeletion?) { context.settingsDataStore.edit { if (value == null) it.remove(pendingDeletionKey) else it[pendingDeletionKey] = ProtocolJson.encodeToString(value) } }
    private val deletionKey = stringPreferencesKey("account_deletion_receipt")
    suspend fun isDeleted(account: String): Boolean = account in context.settingsDataStore.data.first()[deletedKey].orEmpty()
    suspend fun deletionReceipt(): SavedAccountDeletion? = context.settingsDataStore.data.first()[deletionKey]?.let { ProtocolJson.decodeFromString<SavedAccountDeletion>(it) }
    suspend fun saveDeletion(value: SavedAccountDeletion) { context.settingsDataStore.edit {
        it[deletionKey] = ProtocolJson.encodeToString(value)
        it.remove(pendingDeletionKey)
        it[deletedKey] = it[deletedKey].orEmpty() + value.accountId
        it.remove(key(value.accountId)); it.remove(legacyKey(value.accountId)); it.remove(echoKey(value.accountId))
    } }
    private fun key(account: String) = stringPreferencesKey("account_profile_${accountScope(account)}")
    private fun legacyKey(account: String) = stringPreferencesKey("profile_${accountScope(account)}")
    private fun echoKey(account: String) = stringPreferencesKey("echo_schedule_${accountScope(account)}")
    suspend fun echoSchedule(account: String): ai.impo.client.EchoSchedule? = context.settingsDataStore.data.first()[echoKey(account)]?.let {
        runCatching { ProtocolJson.decodeFromString<ai.impo.client.EchoSchedule>(it) }.getOrNull()?.takeIf { it.isValid }
    }
    suspend fun saveEchoSchedule(account: String, value: ai.impo.client.EchoSchedule) { context.settingsDataStore.edit {
        if (account !in it[deletedKey].orEmpty()) it[echoKey(account)] = ProtocolJson.encodeToString(value)
    } }
    fun observe(account: String): Flow<UserSettings> = context.settingsDataStore.data.map { values ->
        decodeProfileCache(values[key(account)], values[legacyKey(account)]).settings
    }
    override suspend fun read(account: String): ProfileCache = context.settingsDataStore.data.first().let { decodeProfileCache(it[key(account)], it[legacyKey(account)]) }
    override suspend fun update(account: String, change: (ProfileCache) -> ProfileCache): ProfileCache {
        var saved: ProfileCache? = null
        context.settingsDataStore.edit { values ->
            saved = change(decodeProfileCache(values[key(account)], values[legacyKey(account)]))
            values[key(account)] = ProtocolJson.encodeToString(saved!!)
            values.remove(legacyKey(account))
        }
        return requireNotNull(saved)
    }
    suspend fun save(account: String, value: UserSettings) { update(account) { it.copy(settings = value) } }
    suspend fun developmentEndpoint(): String? = context.settingsDataStore.data.first()[stringPreferencesKey("development_endpoint")]
    suspend fun setDevelopmentEndpoint(value: String?) { context.settingsDataStore.edit { if (value == null) it.remove(stringPreferencesKey("development_endpoint")) else it[stringPreferencesKey("development_endpoint")] = value } }
}
