package ai.impo.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import ai.impo.client.ClientAction

/** The platform adapter receives typed actions only from a user tap. */
@Composable fun ClientActions(actions: List<ClientAction>) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var notice by remember(actions.map { it.id }) { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        actions.forEach { action ->
            OutlinedButton(onClick = {
                if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    notice = try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(action.targetUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        null
                    } catch (_: android.content.ActivityNotFoundException) { "No app is available to open this action." }
                      catch (_: SecurityException) { "Couldn't open this action. Try again." }
                }
            }, modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp).testTag("message.action.${action.capability}")) {
                Icon(when { action.capability == "impo_navigate" -> Icons.Outlined.NearMe; action.isVideo -> Icons.Outlined.PlayCircle; else -> Icons.Outlined.Link }, null)
                Column(Modifier.weight(1f).padding(horizontal = 12.dp), horizontalAlignment = Alignment.Start) {
                    Text(action.title, style = MaterialTheme.typography.titleSmall)
                    Text(action.detail, style = MaterialTheme.typography.bodySmall, color = Muted, maxLines = 2)
                }
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, null)
            }
        }
        notice?.let { Text(it, color = Muted, style = MaterialTheme.typography.bodySmall) }
    }
}
