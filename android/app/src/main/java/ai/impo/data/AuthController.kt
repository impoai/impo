package ai.impo.data

import ai.impo.BuildConfig
import ai.impo.client.*
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.network.serialization.errorMessage
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.sso.OAuthProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.net.URI

data class Account(val id: String, val name: String, val email: String?, val baseUrl: String, val development: Boolean, val sessionId: String? = null) {
    /** Persistent data belongs to id; in-flight work belongs to this particular login. */
    val requestScope: String get() = "$baseUrl|$id|${sessionId ?: "development"}"
    internal fun requireCurrent(current: Account?, sdkUserId: String?, sdkSessionId: String?) {
        if (current?.requestScope != requestScope || (!development && (sdkUserId != id || sdkSessionId != sessionId || sessionId == null)))
            throw AccountChangedException()
    }
}
data class AuthState(val loading: Boolean = true, val account: Account? = null, val error: String? = null)
enum class SignInProvider { Google, Apple }
class AuthController(private val store: SettingsStore, private val scope: CoroutineScope, val configured: Boolean) {
    private val mutable = MutableStateFlow(AuthState())
    val state = mutable.asStateFlow()
    init {
        scope.launch {
            val local = if (BuildConfig.DEBUG) store.developmentEndpoint() else null
            if (local != null) connectDevelopment(local)
            else if (!configured) mutable.value = AuthState(loading = false)
            if (configured) combine(Clerk.isInitialized, Clerk.userFlow, Clerk.sessionFlow, store.deletedAccounts) { ready, user, session, deleted ->
                if (mutable.value.account?.development != true) {
                    mutable.value = when {
                        !ready -> AuthState()
                        user == null || session == null -> AuthState(loading = false)
                        user.id in deleted -> AuthState(loading = false)
                        session.user?.id != user.id -> AuthState()
                        BuildConfig.API_BASE_URL.isBlank() -> AuthState(false, error = "Configure the Impo API URL for this build.")
                        else -> AuthState(false, Account(user.id, user.firstName.orEmpty(), user.emailAddresses?.firstOrNull()?.emailAddress, BuildConfig.API_BASE_URL, false, session.id))
                    }
                }
            }.collect()
        }
    }
    suspend fun connectDevelopment(endpoint: String) {
        check(BuildConfig.DEBUG) { "Development access is unavailable in release builds" }
        val uri = URI(endpoint.trim().trimEnd('/'))
        require(uri.host in setOf("localhost", "127.0.0.1", "10.0.2.2") && uri.scheme == "http" && uri.userInfo == null && uri.query == null && uri.fragment == null) { "Use a local development server (localhost or 10.0.2.2)." }
        val url = uri.toString()
        store.setDevelopmentEndpoint(url)
        mutable.value = AuthState(false, Account("development:alice:$url", "Developer", "Local development", url, true))
    }
    suspend fun signIn(provider: SignInProvider) {
        if (!configured) { mutable.value = AuthState(false, error = "Set your Clerk publishable key and API URL to enable sign-in."); return }
        if (state.value.account != null) return
        if (Clerk.user?.id?.let { store.isDeleted(it) } == true) Clerk.auth.signOut()
        mutable.update { it.copy(error = null) }
        // The pinned SDK's Account Portal method sends no strategy and cannot
        // obtain a browser URL. Its supported OAuth flow also transfers new
        // users to sign-up and activates the session after the native callback.
        val oauth = when (provider) {
            SignInProvider.Google -> OAuthProvider.GOOGLE
            SignInProvider.Apple -> OAuthProvider.APPLE
        }
        when (val result = Clerk.auth.signInWithOAuth(oauth)) {
            is ClerkResult.Failure -> mutable.update { if (it.account == null) it.copy(loading = false, error = result.errorMessage) else it }
            is ClerkResult.Success -> Unit // SDK account flow is the authority, not browser dismissal.
        }
    }
    suspend fun signOut() {
        val captured = mutable.value.account ?: return
        if (!captured.development && configured) when (val result = Clerk.auth.signOut(captured.sessionId)) {
            is ClerkResult.Failure -> throw IllegalStateException(result.errorMessage)
            is ClerkResult.Success -> Unit
        }
        if (mutable.value.account?.requestScope?.let { it != captured.requestScope } == true) return
        store.setDevelopmentEndpoint(null)
        if (mutable.value.account?.requestScope?.let { it != captured.requestScope } != true) mutable.value = AuthState(false)
    }
    suspend fun finishAccountDeletion(captured: Account) {
        if (mutable.value.account?.requestScope == captured.requestScope) mutable.value = AuthState(false)
        if (!captured.development && configured) Clerk.auth.signOut(captured.sessionId)
        if (captured.development) store.setDevelopmentEndpoint(null)
    }
    fun tokenProvider(account: Account): TokenProvider = object : TokenProvider {
        override suspend fun token(): SessionToken = read(false)
        override suspend fun refresh(rejected: SessionToken): SessionToken = read(true)
        private suspend fun read(refresh: Boolean): SessionToken {
            account.requireCurrent(state.value.account, if (account.development) null else Clerk.user?.id, if (account.development) null else Clerk.session?.id)
            if (account.development) return SessionToken(account.id, "instant-dev-alice")
            val result = Clerk.auth.getToken(GetTokenOptions(skipCache = refresh))
            // The SDK may change sessions while token acquisition is suspended.
            // Never tag a new account's credential with an earlier account ID.
            account.requireCurrent(state.value.account, Clerk.user?.id, Clerk.session?.id)
            return when (result) {
                is ClerkResult.Success -> SessionToken(account.id, result.value)
                is ClerkResult.Failure -> throw ApiException(401, "unauthorized", "Your session expired. Please sign in again.")
            }
        }
    }
}
