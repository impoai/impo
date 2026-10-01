package ai.impo.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.impo.client.AccountDeletionChallenge
import ai.impo.client.ApiException
import ai.impo.data.AppViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable fun DeleteAccountDialog(vm: AppViewModel, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var challenge by remember { mutableStateOf<AccountDeletionChallenge?>(null) }
    var confirmation by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = { if (!busy) dismiss() },
        title = { Text(if (challenge == null) "Delete your account?" else "One final confirmation") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("This permanently deletes your conversations, tasks, Briefs, memories and Echo recordings, including audio waiting to upload on this device. Your connected apps will be disconnected.")
            Text("You will be signed out immediately. Cloud cleanup normally finishes within 24 hours. This cannot be undone. Data in your connected apps stays in those apps.")
            if (challenge != null) OutlinedTextField(confirmation, { confirmation = it }, label = { Text("Type DELETE to confirm") },
                singleLine = true, enabled = !busy, modifier = Modifier.testTag("account-deletion.confirmation"))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { TextButton(enabled = !busy && (challenge == null || confirmation == "DELETE"),
            modifier = Modifier.testTag(if (challenge == null) "account-deletion.continue" else "account-deletion.delete"),
            onClick = {
                busy = true; error = null
                scope.launch {
                    try {
                        val ready = challenge
                        if (ready == null) challenge = vm.prepareAccountDeletion()
                        else { vm.deleteAccount(ready, confirmation); dismiss() }
                    } catch (e: CancellationException) { throw e }
                      catch (e: Exception) {
                        error = if (e is ApiException) e.message else "Couldn't confirm deletion. Check your connection and try again."
                        if (e is ApiException && e.statusCode == 409) { challenge = null; confirmation = "" }
                    } finally { busy = false }
                }
            }) { Text(if (busy) "Please wait…" else if (challenge == null) "Continue" else "Permanently delete", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = dismiss, enabled = !busy) { Text("Cancel") } })
}

@Composable fun AccountDeletionStatusDialog(vm: AppViewModel) {
    val saved by vm.deletionReceipt.collectAsStateWithLifecycle()
    val cleanupError by vm.deletionCleanupError.collectAsStateWithLifecycle()
    var dismissedId by rememberSaveable { mutableStateOf<String?>(null) }
    val receipt = saved ?: return
    if (dismissedId == receipt.receipt.requestId) return
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var status by remember(receipt.receipt.requestId) { mutableStateOf(receipt.receipt.status) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = { dismissedId = receipt.receipt.requestId },
        title = { Text(if (status == "deleted") "Your account is deleted." else "Your account is closed.") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (status == "deleted") "Your account and its cloud cleanup are complete."
                 else "You have been signed out. Your account data is unavailable, and cloud cleanup is running. It normally finishes within 24 hours. Check here for confirmation.")
            if (receipt.receipt.appleManualRevocationRequired) Text("Apple authorization could not be removed automatically. Remove Impo under Sign in with Apple in your Apple Account settings. This does not delay your Impo account deletion.")
            cleanupError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            TextButton(onClick = { openWeb(context, "https://impo.ai/privacy/#delete") }) { Text("Privacy and retention details") }
            TextButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    try { status = vm.checkAccountDeletion(); error = null }
                    catch (e: CancellationException) { throw e }
                    catch (_: Exception) { error = "Couldn't check the status. Your request is still saved; try again when online." }
                    finally { busy = false }
                }
            }) { Text(if (busy) "Checking…" else "Check deletion status") }
        } },
        confirmButton = { TextButton(onClick = { dismissedId = receipt.receipt.requestId }) { Text("Done") } })
}
