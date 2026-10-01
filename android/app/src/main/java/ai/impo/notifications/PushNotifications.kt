package ai.impo.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import ai.impo.BuildConfig
import ai.impo.ImpoApplication
import ai.impo.MainActivity
import ai.impo.R
import ai.impo.client.*
import ai.impo.data.Account
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.encodeToString
import java.util.UUID

data class PushState(val preferences: NotificationPreferences = NotificationPreferences(), val loaded: Boolean = false, val error: String? = null)

/** Native transport and OS presentation. Shared category/foreground policy lives on the server. */
class PushNotifications(private val app: ImpoApplication) {
    private val storage = app.getSharedPreferences("impo_push", Context.MODE_PRIVATE)
    private val network = Mutex()
    private val mutable = MutableStateFlow(PushState())
    val state = mutable.asStateFlow()
    private val mutableRoute = MutableStateFlow<PushRoute?>(null)
    val route = mutableRoute.asStateFlow()
    @Volatile private var foreground = false
    private var account: Account? = null
    private var client: ImpoClient? = null
    private var token: String? = null
    private var revoking = false
    private var pending = mutableMapOf<String, Boolean>()
    val configured: Boolean
    init {
        configured = listOf(BuildConfig.FIREBASE_APPID, BuildConfig.FIREBASE_APIKEY, BuildConfig.FIREBASE_SENDERID, BuildConfig.FIREBASE_PROJECTID).all { it.isNotBlank() }
        if (configured && FirebaseApp.getApps(app).isEmpty()) FirebaseApp.initializeApp(app, FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APPID).setApiKey(BuildConfig.FIREBASE_APIKEY)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDERID).setProjectId(BuildConfig.FIREBASE_PROJECTID).build())
        val manager = app.getSystemService(NotificationManager::class.java)
        for ((id, title) in listOf("chat" to "Chat replies", "tasks" to "Task updates", "brief" to "Brief")) {
            manager.createNotificationChannel(NotificationChannel("impo_$id", title, NotificationManager.IMPORTANCE_DEFAULT))
        }
        app.scope.launch { while (isActive) { if (foreground) refresh(); delay(20_000) } }
    }
    private fun persistentId(key: String): String = storage.getString(key, null) ?: UUID.randomUUID().toString().also { check(storage.edit().putString(key, it).commit()) }
    @Synchronized private fun revision(): Long = (storage.getLong("revision", 0) + 1).also { check(storage.edit().putLong("revision", it).commit()) }
    private fun preferenceKey() = "preferences_" + java.security.MessageDigest.getInstance("SHA-256").digest((account?.requestScope ?: "").toByteArray()).joinToString("") { "%02x".format(it) }
    private fun registration() = storage.getString("registration", null)
    fun configure(value: Account?) {
        client = value?.let { ImpoClient(it.baseUrl, app.auth.tokenProvider(it), allowInsecureLocalhost = it.development && BuildConfig.DEBUG) }
        if (account?.requestScope == value?.requestScope && value != null && !revoking && registration() != null) return
        account = value; revoking = false
        if (value == null) {
            storage.edit().remove("scope").remove("registration").remove("activePreferences").apply()
            mutable.value = PushState(); mutableRoute.value = null; cancelAlerts(); return
        }
        if (storage.getString("scope", null) != value.requestScope || registration() == null) {
            check(storage.edit().putString("scope", value.requestScope).putString("registration", UUID.randomUUID().toString()).commit()); mutableRoute.value = null; cancelAlerts()
        }
        val saved = runCatching { ProtocolJson.decodeFromString<NotificationPreferences>(storage.getString(preferenceKey(), "{}")!!) }.getOrDefault(NotificationPreferences())
        pending = runCatching { ProtocolJson.decodeFromString<Map<String, Boolean>>(storage.getString(preferenceKey() + "_pending", "{}")!!) }.getOrDefault(emptyMap()).toMutableMap()
        mutable.value = PushState(saved); persist()
        app.scope.launch { refresh() }
    }
    fun foreground(value: Boolean) { foreground = value; app.scope.launch { refresh() } }
    fun newToken(value: String) { app.scope.launch { token = value; refresh() } }
    fun set(category: String, enabled: Boolean) {
        if (account == null) return
        mutable.value = mutable.value.copy(preferences = mutable.value.preferences.setting(category, enabled))
        pending[category] = enabled; persist()
        if (!enabled) cancelAlerts(category)
        app.scope.launch { refresh() }
    }
    private fun persist() {
        val encoded = ProtocolJson.encodeToString(mutable.value.preferences)
        storage.edit().putString(preferenceKey(), encoded).putString("activePreferences", encoded)
            .putString(preferenceKey() + "_pending", ProtocolJson.encodeToString(pending.toMap())).apply()
    }
    suspend fun refresh() = network.withLock {
        val owner = account ?: return@withLock
        val api = client ?: return@withLock
        val registration = registration() ?: return@withLock
        fun current() = !revoking && account?.requestScope == owner.requestScope && registration() == registration
        if (!current()) return@withLock
        try {
            val enabled = NotificationManagerCompat.from(app).areNotificationsEnabled()
            if (configured && enabled && token == null) {
                FirebaseMessaging.getInstance().isAutoInitEnabled = true
                // Settings and foreground presence must still sync when Play services is unavailable.
                token = try { withTimeoutOrNull(10_000) { FirebaseMessaging.getInstance().token.await() } }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { null }
            }
            if (!current()) return@withLock
            api.registerPush(persistentId("installation"), persistentId("secret"), revision(), registration, if (enabled) token else null, enabled && configured, foreground)
            if (!current()) return@withLock
            for ((category, value) in pending.toMap()) {
                val saved = api.updateNotificationPreference(category, value)
                if (!current()) return@withLock
                if (pending[category] == value) pending.remove(category)
                mutable.value = mutable.value.copy(preferences = pending.entries.fold(saved) { settings, change -> settings.setting(change.key, change.value) }); persist()
            }
            val saved = api.notificationPreferences()
            if (!current()) return@withLock
            mutable.value = PushState(pending.entries.fold(saved) { settings, change -> settings.setting(change.key, change.value) }, loaded = true); persist()
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            if (current()) {
                mutable.value = mutable.value.copy(error = "Notification settings couldn't sync. We'll retry when you're connected.")
                if (error is ApiException && error.code == "push_token_conflict" && configured) { FirebaseMessaging.getInstance().deleteToken(); token = null }
            }
        }
    }
    suspend fun revokeBeforeSignOut() {
        revoking = true
        try {
            network.withLock {
                val api = client ?: return@withLock
                val registration = registration() ?: return@withLock
                try { api.revokePush(persistentId("installation"), persistentId("secret"), revision(), registration) }
                catch (error: ApiException) { if (error.statusCode != 404) throw error }
                check(storage.edit().remove("scope").remove("registration").remove("activePreferences").commit())
                cancelAlerts(); token = null; mutableRoute.value = null
                if (configured) {
                    FirebaseMessaging.getInstance().isAutoInitEnabled = false
                    try { withTimeoutOrNull(10_000) { FirebaseMessaging.getInstance().deleteToken().await() } }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Server revocation is authoritative; retry on the next registration. */ }
                }
            }
        } catch (error: Exception) { revoking = false; throw error }
    }
    fun opened(intent: Intent) {
        val raw = intent.getStringExtra("impo.push.route") ?: return
        intent.removeExtra("impo.push.route")
        val route = runCatching { ProtocolJson.decodeFromString<PushRoute>(raw) }.getOrNull() ?: return
        if (route.isCurrent(registration())) mutableRoute.value = route
    }
    fun consumeRoute() { mutableRoute.value = null }
    @Synchronized fun receive(data: Map<String, String>) {
        val route = PushRoute.parse(data) ?: return
        val seen = storage.getString("seen", "")!!.split(',').filter { it.isNotEmpty() }
        if (route.eventId in seen || !route.isCurrent(registration())) return
        check(storage.edit().putString("seen", (seen + route.eventId).takeLast(100).joinToString(",")).commit())
        val preferences = runCatching { ProtocolJson.decodeFromString<NotificationPreferences>(storage.getString("activePreferences", "{}")!!) }.getOrDefault(NotificationPreferences())
        if (foreground || !preferences.enabled(route.category) || storage.getString("scope", null) == null || !NotificationManagerCompat.from(app).areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("impo.push.route", ProtocolJson.encodeToString(route))
        val pending = PendingIntent.getActivity(app, route.eventId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = when (route.category) { "chat" -> "Your chat has an update"; "tasks" -> "Your task has an update"; else -> "Your Brief is ready" }
        val notification = NotificationCompat.Builder(app, "impo_${route.category}").setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title).setContentText("Open Impo to see your update.").setAutoCancel(true).setContentIntent(pending)
            .setGroup("impo_${route.category}").setOnlyAlertOnce(true).build()
        NotificationManagerCompat.from(app).notify(route.eventId, route.eventId.hashCode(), notification)
    }
    private fun cancelAlerts(category: String? = null) {
        val manager = app.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.notification.channelId.startsWith("impo_") && (category == null || it.notification.channelId == "impo_$category") }
            .forEach { manager.cancel(it.tag, it.id) }
    }
}
class ImpoMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { (application as ImpoApplication).push.newToken(token) }
    override fun onMessageReceived(message: RemoteMessage) { (application as ImpoApplication).push.receive(message.data) }
}
