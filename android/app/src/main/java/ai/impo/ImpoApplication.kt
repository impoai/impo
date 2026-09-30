package ai.impo

import android.app.Application
import ai.impo.data.AuthController
import ai.impo.data.SettingsStore
import ai.impo.client.ImpoClient
import ai.impo.nativebridge.NativeAccount
import ai.impo.nativebridge.NativeBridge
import com.clerk.api.Clerk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.distinctUntilChangedBy

class ImpoApplication : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var settings: SettingsStore
    lateinit var auth: AuthController
    @Volatile var nativeAccount: NativeAccount? = null
    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        val configured = BuildConfig.CLERK_PUBLISHABLE_KEY.isNotBlank()
        if (configured) Clerk.initialize(this, publishableKey = BuildConfig.CLERK_PUBLISHABLE_KEY)
        auth = AuthController(settings, scope, configured)
        NativeBridge.install(this) { nativeAccount }
        scope.launch {
            auth.state.distinctUntilChangedBy { it.account?.requestScope }.collect { state ->
                nativeAccount?.api?.cancelInFlight()
                nativeAccount = state.account?.let { NativeAccount(it.id, ImpoClient(it.baseUrl, auth.tokenProvider(it), allowInsecureLocalhost = it.development && BuildConfig.DEBUG)) }
                NativeBridge.accountChanged(this@ImpoApplication)
            }
        }
    }
}
