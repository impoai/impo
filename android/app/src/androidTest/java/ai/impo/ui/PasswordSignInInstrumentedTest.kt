package ai.impo.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import ai.impo.data.PasswordSignInFlow
import ai.impo.data.PasswordSignInService
import com.clerk.api.network.model.factor.Factor
import com.clerk.api.signin.SignIn
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PasswordSignInInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun formHandlesWrongPasswordVerificationAndResetNavigation() {
        val service = FormPasswordService()
        val flow = PasswordSignInFlow(service)
        compose.setContent { ImpoTheme { PasswordSignInScreen(flow) {} } }
        compose.onNodeWithTag("auth.submit").assertIsNotEnabled()
        compose.onNodeWithTag("auth.email").performTextInput("test@example.com")
        compose.onNodeWithTag("auth.password").performTextInput("wrong")
        compose.onNodeWithTag("auth.submit").performScrollTo().performClick()
        compose.onNodeWithText("Incorrect password").assertExists()
        compose.onNodeWithTag("auth.submit").assertIsNotEnabled()
        compose.onNodeWithTag("auth.forgot").performScrollTo().performClick()
        compose.onNodeWithText("Reset your password").assertExists()
        compose.onNodeWithTag("auth.password").assertDoesNotExist()
        compose.onNodeWithText("Back to sign in").performScrollTo().performClick()
        compose.onNodeWithTag("auth.password").performScrollTo().performTextInput("correct password")
        compose.onNodeWithTag("auth.submit").performScrollTo().performClick()
        compose.onNodeWithTag("auth.code").assertExists().performScrollTo().performTextInput("000000")
        compose.onNodeWithTag("auth.submit").performScrollTo().performClick()
        compose.onNodeWithText("Incorrect code").assertExists()
        assertFalse(service.activated)
        compose.onNodeWithTag("auth.code").performScrollTo().performTextInput("123456")
        compose.onNodeWithTag("auth.submit").performScrollTo().performClick()
        compose.onNodeWithText("You're signed in").assertExists()
        assertTrue(service.activated)
    }
}

private class FormPasswordService : PasswordSignInService {
    var activated = false
    override suspend fun start(email: String, password: String?): SignIn {
        check(password == "correct password") { "Incorrect password" }
        return SignIn("attempt", SignIn.Status.NEEDS_CLIENT_TRUST, supportedSecondFactors = listOf(Factor("email_code", emailAddressId = "email_1")))
    }
    override suspend fun sendCode(attempt: SignIn, factor: Factor, secondFactor: Boolean) = attempt
    override suspend fun verify(attempt: SignIn, code: String, factor: Factor, secondFactor: Boolean): SignIn {
        check(code == "123456") { "Incorrect code" }
        check(secondFactor)
        return SignIn("attempt", SignIn.Status.COMPLETE, createdSessionId = "session_1")
    }
    override suspend fun resetPassword(attempt: SignIn, password: String) = error("Not used by this UI test")
    override suspend fun activate(sessionId: String) { check(sessionId == "session_1"); activated = true }
}
