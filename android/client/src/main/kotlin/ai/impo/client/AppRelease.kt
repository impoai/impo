package ai.impo.client

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

@Serializable data class AppRelease(val version: String, val build: Int, val url: String, val minimumSystemVersion: String) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        @Serializable private data class Envelope(val schemaVersion: Int, val platform: String, val channel: String, val latest: AppRelease?)
        fun update(raw: String, installedBuild: Int, sdk: Int): AppRelease? = runCatching {
            require(raw.toByteArray().size <= 8192 && installedBuild > 0)
            val envelope = json.decodeFromString<Envelope>(raw)
            require(envelope.schemaVersion == 1 && envelope.platform == "android" && envelope.channel == "apk")
            envelope.latest?.takeIf {
                it.build > installedBuild && it.version.length <= 32 && it.version.matches(Regex("[0-9]+(?:\\.[0-9]+){0,2}")) &&
                    it.minimumSystemVersion.toIntOrNull()?.let { minimum -> minimum in 28..sdk } == true &&
                    it.url == "https://impo.ai/android.apk"
            }
        }.getOrNull()
    }
}

class AppReleaseClient(private val baseUrl: String = "https://impo.ai", private val http: OkHttpClient = OkHttpClient.Builder()
    .callTimeout(5, TimeUnit.SECONDS).connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
    .followRedirects(false).build()) {
    /** Public request: no account token, cookies or identifiers. Failure is silent. */
    suspend fun check(installedBuild: Int, sdk: Int): AppRelease? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url("${baseUrl.trimEnd('/')}/app-releases/android-apk.json").header("Accept", "application/json").header("Cache-Control", "no-cache").build()
            http.newCall(request).execute().use { response ->
                if (response.code != 200 || response.body?.contentType()?.let { it.type == "application" && it.subtype == "json" } != true) return@use null
                val source = response.body!!.source()
                source.request(8193)
                if (source.buffer.size > 8192) return@use null
                AppRelease.update(source.readUtf8(), installedBuild, sdk)
            }
        }.getOrNull()
    }
}
