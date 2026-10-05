package ai.impo.data

import com.clerk.api.Clerk
import com.clerk.api.auth.types.MfaType
import com.clerk.api.network.model.error.ClerkErrorResponse
import com.clerk.api.network.model.factor.Factor
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.network.serialization.errorMessage
import com.clerk.api.signin.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal interface PasswordSignInService {
    suspend fun start(email: String, password: String?): SignIn
    suspend fun sendCode(attempt: SignIn, factor: Factor, secondFactor: Boolean): SignIn
    suspend fun verify(attempt: SignIn, code: String, factor: Factor, secondFactor: Boolean): SignIn
    suspend fun resetPassword(attempt: SignIn, password: String): SignIn
    suspend fun activate(sessionId: String)
}

internal class ClerkPasswordSignInService(private val prepare: suspend () -> Unit) : PasswordSignInService {
    override suspend fun start(email: String, password: String?): SignIn {
        prepare()
        return if (password == null) Clerk.auth.signIn { this.email = email }.valueOrThrow()
        else Clerk.auth.signInWithPassword { identifier = email; this.password = password }.valueOrThrow()
    }
    override suspend fun sendCode(attempt: SignIn, factor: Factor, secondFactor: Boolean): SignIn = when (factor.strategy) {
        "reset_password_email_code" -> attempt.prepareFirstFactor(SignIn.PrepareFirstFactorParams.ResetPasswordEmailCode(emailAddressId = factor.emailAddressId.orEmpty())).valueOrThrow()
        "email_code" -> if (secondFactor) attempt.sendMfaEmailCode(factor.emailAddressId).valueOrThrow() else attempt.sendEmailCode(factor.emailAddressId).valueOrThrow()
        "phone_code" -> if (secondFactor) attempt.sendMfaPhoneCode(factor.phoneNumberId).valueOrThrow() else attempt.sendPhoneCode(factor.phoneNumberId).valueOrThrow()
        "totp", "backup_code" -> attempt
        else -> error("Use Apple or Google to sign in to this account.")
    }
    override suspend fun verify(attempt: SignIn, code: String, factor: Factor, secondFactor: Boolean): SignIn {
        if (!secondFactor) return attempt.verifyCode(code).valueOrThrow()
        val type = when (factor.strategy) {
            "email_code" -> MfaType.EMAIL_CODE
            "phone_code" -> MfaType.PHONE_CODE
            "totp" -> MfaType.TOTP
            "backup_code" -> MfaType.BACKUP_CODE
            else -> error("Choose another verification method.")
        }
        return attempt.verifyMfaCode(code, type).valueOrThrow()
    }
    override suspend fun resetPassword(attempt: SignIn, password: String): SignIn =
        attempt.resetPassword(password, signOutOfOtherSessions = true).valueOrThrow()
    override suspend fun activate(sessionId: String) {
        val session = Clerk.auth.setActive(sessionId).valueOrThrow()
        check(session.id == sessionId && Clerk.session?.id == sessionId && Clerk.user?.id == session.user?.id) { "Your session changed. Please sign in again." }
    }
}

private fun <T : Any> ClerkResult<T, ClerkErrorResponse>.valueOrThrow(): T = when (this) {
    is ClerkResult.Success -> value
    is ClerkResult.Failure -> throw IllegalStateException(errorMessage)
}

internal enum class PasswordStep { Credentials, ResetEmail, Code, NewPassword, Complete }
internal data class PasswordSignInState(
    val step: PasswordStep = PasswordStep.Credentials,
    val busy: Boolean = false,
    val error: String? = null,
    val factor: Factor? = null,
    val factors: List<Factor> = emptyList(),
    val codeSent: Boolean = false,
) {
    val codeHelp: String get() = when (factor?.strategy) {
        "totp" -> "Enter the code from your authenticator app."
        "backup_code" -> "Enter one of your unused backup codes."
        "phone_code" -> "Enter the code sent to ${factor.safeIdentifier ?: "your phone"}."
        else -> "Enter the code sent to ${factor?.safeIdentifier ?: "your email"}."
    }
    val canResend: Boolean get() = factor?.strategy !in setOf("totp", "backup_code")
}

/** Incomplete verification never activates a session or bypasses account restoration. */
internal class PasswordSignInFlow(private val service: PasswordSignInService) {
    private val mutable = MutableStateFlow(PasswordSignInState())
    val state = mutable.asStateFlow()
    private var signIn: SignIn? = null
    private var secondFactor = false

    fun startOver(reset: Boolean = false) {
        if (state.value.busy) return
        signIn = null
        mutable.value = PasswordSignInState(step = if (reset) PasswordStep.ResetEmail else PasswordStep.Credentials)
    }
    suspend fun signIn(email: String, password: String) = perform {
        require(email.trim().isNotEmpty() && password.isNotEmpty()) { "Enter your email and password." }
        advance(service.start(email.trim(), password))
    }
    suspend fun sendReset(email: String) = perform {
        require(email.trim().isNotEmpty()) { "Enter your account email." }
        val attempt = service.start(email.trim(), null)
        signIn = attempt
        val factor = attempt.supportedFirstFactors?.firstOrNull { it.strategy == "reset_password_email_code" }
            ?: error("This account has no password to reset. Continue with Apple or Google.")
        secondFactor = false
        mutable.update { it.copy(factors = listOf(factor)) }
        prepare(factor)
    }
    suspend fun selectFactor(factor: Factor) = perform { prepare(factor) }
    suspend fun resend() = perform {
        state.value.factor?.takeIf { state.value.canResend }?.let { prepare(it) }
    }
    suspend fun verify(code: String) = perform {
        val attempt = signIn ?: error("Start signing in again.")
        val factor = state.value.factor ?: error("Choose a verification method.")
        check(state.value.codeSent) { "Send a verification code first." }
        require(code.trim().isNotEmpty()) { "Enter your verification code." }
        advance(service.verify(attempt, code.trim(), factor, secondFactor))
    }
    suspend fun reset(password: String) = perform {
        check(state.value.step == PasswordStep.NewPassword) { "Verify your account first." }
        require(password.isNotEmpty()) { "Enter a new password." }
        advance(service.resetPassword(checkNotNull(signIn), password))
    }
    private suspend fun perform(operation: suspend () -> Unit) {
        if (state.value.busy) return
        mutable.update { it.copy(busy = true, error = null) }
        try { operation() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { mutable.update { it.copy(error = failure.message ?: "Couldn't sign in. Please try again.") } }
        finally { mutable.update { it.copy(busy = false) } }
    }
    private suspend fun prepare(factor: Factor) {
        val attempt = signIn ?: return
        mutable.update { it.copy(step = PasswordStep.Code, factor = factor, codeSent = false) }
        signIn = service.sendCode(attempt, factor, secondFactor)
        mutable.update { it.copy(codeSent = true) }
    }
    private suspend fun advance(attempt: SignIn) {
        currentCoroutineContext().ensureActive()
        signIn = attempt
        when (attempt.status) {
            SignIn.Status.COMPLETE -> {
                val sessionId = attempt.createdSessionId ?: error("Sign-in did not create a session. Please try again.")
                service.activate(sessionId)
                mutable.update { it.copy(step = PasswordStep.Complete) }
            }
            SignIn.Status.NEEDS_NEW_PASSWORD -> mutable.update { it.copy(step = PasswordStep.NewPassword) }
            SignIn.Status.NEEDS_FIRST_FACTOR, SignIn.Status.NEEDS_SECOND_FACTOR, SignIn.Status.NEEDS_CLIENT_TRUST -> {
                secondFactor = attempt.status != SignIn.Status.NEEDS_FIRST_FACTOR
                val available = (if (secondFactor) attempt.supportedSecondFactors else attempt.supportedFirstFactors).orEmpty()
                val strategies = if (secondFactor) listOf("totp", "email_code", "phone_code", "backup_code") else listOf("email_code", "phone_code")
                val factors = strategies.flatMap { strategy -> available.filter { it.strategy == strategy } }
                mutable.update { it.copy(factors = factors) }
                prepare(factors.firstOrNull() ?: error("Use Apple or Google to sign in to this account."))
            }
            else -> error("Sign-in could not finish. Please try again or continue with Apple or Google.")
        }
    }
}

internal val Factor.passwordFlowLabel: String get() = when (strategy) {
    "totp" -> "Authenticator app"
    "backup_code" -> "Backup code"
    "phone_code" -> "Text message"
    else -> "Email code"
}
