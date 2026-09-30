package ai.impo.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import ai.impo.client.ProtocolJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.security.MessageDigest

private val Context.settingsDataStore by preferencesDataStore("impo_settings")
@Serializable data class UserSettings(
    val displayName: String = "", val assistantName: String = "Momo", val avatar: Int = 0,
    val onboarded: Boolean = false, val wifiOnly: Boolean = false, val recordingLocation: Boolean = false,
    val calendarEnabled: Boolean = false, val healthEnabled: Boolean = false,
)
fun accountScope(id: String): String = MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).joinToString("") { "%02x".format(it) }
class SettingsStore(private val context: Context) {
    private fun key(account: String) = stringPreferencesKey("profile_${accountScope(account)}")
    fun observe(account: String): Flow<UserSettings> = context.settingsDataStore.data.map { values ->
        values[key(account)]?.let { runCatching { ProtocolJson.decodeFromString<UserSettings>(it) }.getOrNull() } ?: UserSettings()
    }
    suspend fun save(account: String, value: UserSettings) { context.settingsDataStore.edit { it[key(account)] = ProtocolJson.encodeToString(value) } }
    suspend fun developmentEndpoint(): String? = context.settingsDataStore.data.first()[stringPreferencesKey("development_endpoint")]
    suspend fun setDevelopmentEndpoint(value: String?) { context.settingsDataStore.edit { if (value == null) it.remove(stringPreferencesKey("development_endpoint")) else it[stringPreferencesKey("development_endpoint")] = value } }
}
