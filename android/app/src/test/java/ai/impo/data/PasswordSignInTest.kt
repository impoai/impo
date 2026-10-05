package ai.impo.data

import com.clerk.api.network.model.factor.Factor
import com.clerk.api.signin.SignIn
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class PasswordSignInTest {
    private val email = Factor("email_code", emailAddressId = "email_1")
    @Test fun passwordSuccessActivatesOnlyTheCreatedSession() = runTest {
        val service = FakePasswordService()
        service.result = SignIn("attempt", SignIn.Status.COMPLETE, createdSessionId = "session_A")
        val flow = PasswordSignInFlow(service)
        flow.signIn(" user@example.com \n", " a password ")
        assertEquals("user@example.com", service.identifier)
        assertEquals(" a password ", service.password)
        assertEquals(listOf("session_A"), service.activated)
        assertEquals(PasswordStep.Complete, flow.state.value.step)
    }
    @Test fun deviceTrustAndWrongCodeCannotActivateSession() = runTest {
        val service = FakePasswordService()
        service.result = SignIn("attempt", SignIn.Status.NEEDS_CLIENT_TRUST, supportedSecondFactors = listOf(email))
        val flow = PasswordSignInFlow(service)
        flow.signIn("user@example.com", "password")
        assertEquals(PasswordStep.Code, flow.state.value.step)
        assertTrue(service.sentSecondFactor)
        service.failure = "Incorrect code"
        flow.verify("000000")
        assertEquals("Incorrect code", flow.state.value.error)
        assertTrue(service.activated.isEmpty())
        service.failure = null
        service.result = SignIn("attempt", SignIn.Status.COMPLETE, createdSessionId = "session_A")
        flow.verify("123456")
        assertTrue(service.verifiedSecondFactor)
        assertEquals(PasswordStep.Complete, flow.state.value.step)
    }
    @Test fun resetRequiresCodeAndAllowsPasswordRetry() = runTest {
        val service = FakePasswordService()
        service.result = SignIn("attempt", SignIn.Status.NEEDS_FIRST_FACTOR, supportedFirstFactors = listOf(Factor("reset_password_email_code", emailAddressId = "email_1")))
        val flow = PasswordSignInFlow(service)
        flow.startOver(reset = true)
        flow.sendReset("user@example.com")
        assertFalse(service.sentSecondFactor)
        assertEquals(PasswordStep.Code, flow.state.value.step)
        service.result = SignIn("attempt", SignIn.Status.NEEDS_NEW_PASSWORD)
        flow.verify("123456")
        assertEquals(PasswordStep.NewPassword, flow.state.value.step)
        assertTrue(service.activated.isEmpty())
        service.failure = "Password is too short"
        flow.reset("x")
        assertEquals("Password is too short", flow.state.value.error)
        assertEquals(PasswordStep.NewPassword, flow.state.value.step)
        service.failure = null
        service.result = SignIn("attempt", SignIn.Status.COMPLETE, createdSessionId = "session_A")
        flow.reset("a stronger password")
        assertEquals(PasswordStep.Complete, flow.state.value.step)
    }
    @Test fun deliveryFailureCanRetryButCannotVerifyUnsentCode() = runTest {
        val service = FakePasswordService()
        service.result = SignIn("attempt", SignIn.Status.NEEDS_CLIENT_TRUST, supportedSecondFactors = listOf(email))
        service.sendFailure = "Try sending again"
        val flow = PasswordSignInFlow(service)
        flow.signIn("user@example.com", "password")
        assertFalse(flow.state.value.codeSent)
        flow.verify("123456")
        assertEquals(0, service.verifyCalls)
        service.sendFailure = null
        flow.resend()
        assertTrue(flow.state.value.codeSent)
        assertNull(flow.state.value.error)
    }
    @Test fun mfaSupportsAuthenticatorAndBackupCodes() = runTest {
        val service = FakePasswordService()
        val backup = Factor("backup_code")
        service.result = SignIn("attempt", SignIn.Status.NEEDS_SECOND_FACTOR, supportedSecondFactors = listOf(backup, Factor("totp")))
        val flow = PasswordSignInFlow(service)
        flow.signIn("user@example.com", "password")
        assertEquals("totp", flow.state.value.factor?.strategy)
        assertFalse(flow.state.value.canResend)
        flow.selectFactor(backup)
        assertEquals("backup_code", flow.state.value.factor?.strategy)
        assertFalse(flow.state.value.canResend)
    }
    @Test fun missingSessionAndActivationFailureNeverFinishSignIn() = runTest {
        val service = FakePasswordService()
        service.result = SignIn("attempt", SignIn.Status.COMPLETE)
        val flow = PasswordSignInFlow(service)
        flow.signIn("user@example.com", "password")
        assertNotNull(flow.state.value.error)
        assertTrue(service.activated.isEmpty())
        service.result = SignIn("attempt", SignIn.Status.COMPLETE, createdSessionId = "session_A")
        service.activationFailure = "Session expired"
        flow.signIn("user@example.com", "password")
        assertEquals("Session expired", flow.state.value.error)
        assertNotEquals(PasswordStep.Complete, flow.state.value.step)
    }
    @Test fun wrongPasswordAndUnsupportedFactorKeepAccountSignedOut() = runTest {
        val service = FakePasswordService()
        val flow = PasswordSignInFlow(service)
        service.failure = "Incorrect password"
        flow.signIn("user@example.com", "wrong")
        assertEquals("Incorrect password", flow.state.value.error)
        service.failure = null
        service.result = SignIn("attempt", SignIn.Status.NEEDS_CLIENT_TRUST, supportedSecondFactors = listOf(Factor("passkey")))
        flow.signIn("user@example.com", "password")
        assertNotNull(flow.state.value.error)
        assertTrue(service.activated.isEmpty())
        flow.startOver()
        assertNull(flow.state.value.factor)
        assertNull(flow.state.value.error)
    }
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun duplicateSubmitAndCancellationDoNotActivateAnAbandonedAttempt() = runTest {
        val service = FakePasswordService()
        service.gate = CompletableDeferred()
        service.result = SignIn("attempt", SignIn.Status.COMPLETE, createdSessionId = "session_A")
        val flow = PasswordSignInFlow(service)
        val task = launch { flow.signIn("user@example.com", "password") }
        runCurrent()
        flow.signIn("another@example.com", "another password")
        flow.startOver()
        assertTrue(flow.state.value.busy)
        assertEquals(1, service.startCalls)
        task.cancel()
        runCurrent()
        assertFalse(flow.state.value.busy)
        assertTrue(service.activated.isEmpty())
    }
}

private class FakePasswordService : PasswordSignInService {
    var result = SignIn("attempt", SignIn.Status.NEEDS_FIRST_FACTOR)
    var failure: String? = null
    var sendFailure: String? = null
    var activationFailure: String? = null
    var gate: CompletableDeferred<Unit>? = null
    var identifier: String? = null
    var password: String? = null
    var sentSecondFactor = false
    var verifiedSecondFactor = false
    var verifyCalls = 0
    var startCalls = 0
    val activated = mutableListOf<String>()
    override suspend fun start(email: String, password: String?): SignIn {
        startCalls++; identifier = email; this.password = password
        gate?.await()
        failure?.let { error(it) }
        return result
    }
    override suspend fun sendCode(attempt: SignIn, factor: Factor, secondFactor: Boolean): SignIn {
        sentSecondFactor = secondFactor
        sendFailure?.let { error(it) }
        return attempt
    }
    override suspend fun verify(attempt: SignIn, code: String, factor: Factor, secondFactor: Boolean): SignIn {
        verifyCalls++; verifiedSecondFactor = secondFactor
        failure?.let { error(it) }
        return result
    }
    override suspend fun resetPassword(attempt: SignIn, password: String): SignIn { failure?.let { error(it) }; return result }
    override suspend fun activate(sessionId: String) { activationFailure?.let { error(it) }; activated.add(sessionId) }
}
