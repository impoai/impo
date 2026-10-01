package ai.impo.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.impo.data.AppViewModel
import kotlinx.coroutines.launch

@Composable fun NotificationCategories(vm: AppViewModel) {
    val push by vm.app.push.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { vm.app.push.refresh() }
    for ((category, title) in listOf("chat" to "Chat replies", "tasks" to "Task updates", "brief" to "Brief")) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f))
            Switch(push.preferences.enabled(category), onCheckedChange = { vm.app.push.set(category, it) }, enabled = push.loaded,
                modifier = Modifier.testTag("notifications.$category"))
        }
    }
    Text("These preferences sync across your devices.", color = Muted, style = MaterialTheme.typography.bodySmall)
    ErrorNotice(push.error, { scope.launch { vm.app.push.refresh() } })
}
