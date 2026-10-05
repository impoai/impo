package ai.impo.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.impo.data.*
import kotlinx.coroutines.launch

@Composable internal fun PasswordSignInScreen(flow: PasswordSignInFlow, close: () -> Unit) {
    val state by flow.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    // Credentials stay in memory and are never written to saved instance state.
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    BackHandler { if (!state.busy) close() }
    val title = when (state.step) {
        PasswordStep.Credentials -> "Sign in with email"
        PasswordStep.ResetEmail -> "Reset your password"
        PasswordStep.Code -> "Verify your account"
        PasswordStep.NewPassword -> "Choose a new password"
        PasswordStep.Complete -> "You're signed in"
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        TextButton(onClick = { password = ""; code = ""; close() }, enabled = !state.busy) { Text("Cancel") }
        Text(title, style = MaterialTheme.typography.headlineLarge, color = Forest)
        when (state.step) {
            PasswordStep.Credentials, PasswordStep.ResetEmail -> {
                Text(if (state.step == PasswordStep.Credentials) "Use the email and password for your Impo account. New here? Go back to continue with Apple or Google."
                    else "We'll send a code to the email on your account.", color = Muted)
                OutlinedTextField(email, { email = it }, label = { Text("Email address") }, singleLine = true, enabled = !state.busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth().testTag("auth.email"))
                if (state.step == PasswordStep.Credentials) {
                    OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, enabled = !state.busy,
                        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth().testTag("auth.password"))
                }
                Button(onClick = {
                    val secret = password; password = ""
                    scope.launch { if (state.step == PasswordStep.Credentials) flow.signIn(email, secret) else flow.sendReset(email) }
                }, enabled = !state.busy && email.isNotBlank() && (state.step == PasswordStep.ResetEmail || password.isNotEmpty()),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth.submit")) {
                    Text(if (state.busy) "Please wait…" else if (state.step == PasswordStep.Credentials) "Sign in" else "Send reset code")
                }
                if (state.step == PasswordStep.Credentials) TextButton(onClick = { password = ""; flow.startOver(reset = true) }, enabled = !state.busy,
                    modifier = Modifier.testTag("auth.forgot")) { Text("Forgot password?") }
            }
            PasswordStep.Code -> {
                Text(state.codeHelp, color = Muted)
                OutlinedTextField(code, { code = it }, label = { Text("Verification code") }, singleLine = true, enabled = !state.busy,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth().testTag("auth.code"))
                Button(onClick = { val entered = code; code = ""; scope.launch { flow.verify(entered) } }, enabled = !state.busy && code.isNotBlank() && state.codeSent,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth.submit")) { Text(if (state.busy) "Verifying…" else "Verify") }
                if (state.canResend) TextButton(onClick = { scope.launch { flow.resend() } }, enabled = !state.busy,
                    modifier = Modifier.testTag("auth.resend")) { Text(if (state.codeSent) "Resend code" else "Send code") }
                if (state.factors.size > 1) state.factors.filter { it != state.factor }.forEach { factor ->
                    TextButton(onClick = { code = ""; scope.launch { flow.selectFactor(factor) } }, enabled = !state.busy) { Text("Use ${factor.passwordFlowLabel.lowercase()}") }
                }
            }
            PasswordStep.NewPassword -> {
                Text("Choose a password you haven't used elsewhere. Your other sessions will be signed out.", color = Muted)
                OutlinedTextField(password, { password = it }, label = { Text("New password") }, singleLine = true, enabled = !state.busy,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth().testTag("auth.newPassword"))
                Button(onClick = { val secret = password; password = ""; scope.launch { flow.reset(secret) } }, enabled = !state.busy && password.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("auth.submit")) { Text(if (state.busy) "Saving…" else "Save password and sign in") }
            }
            PasswordStep.Complete -> CircularProgressIndicator()
        }
        ErrorNotice(state.error)
        if (state.step !in setOf(PasswordStep.Credentials, PasswordStep.Complete)) {
            TextButton(onClick = { password = ""; code = ""; flow.startOver() }, enabled = !state.busy) { Text("Back to sign in") }
        }
    }
}
