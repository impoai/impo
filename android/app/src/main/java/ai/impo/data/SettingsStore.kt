package ai.impo.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
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
    val onboarded: Boolean = false, val wifiOnly: Boolean = false, val recordingLocation: Boolean = false,
    val calendarEnabled: Boolean = false, val healthEnabled: Boolean = false, val contactsEnabled: Boolean = false,
)
@Serializable data class ProfileCache(val settings: UserSettings = UserSettings(), val pending: ProfileUpdate? = null, val pendingDisplayName: String? = null)
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
    private fun key(account: String) = stringPreferencesKey("account_profile_${accountScope(account)}")
    private fun legacyKey(account: String) = stringPreferencesKey("profile_${accountScope(account)}")
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
