package ai.impo

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.lifecycle.lifecycleScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import ai.impo.data.AppViewModel
import ai.impo.ui.ImpoApp
import ai.impo.ui.ImpoTheme
import com.clerk.api.Clerk
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model: AppViewModel by viewModels()
    private var showHealthPrivacy by mutableStateOf(false)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        val app = application as ImpoApplication
        app.upgrade.checkOnce(app.scope) {
            if (BuildConfig.DEBUG) intent.getStringExtra("impo.test.release")?.let {
                ai.impo.client.AppRelease.update(it, BuildConfig.VERSION_CODE, android.os.Build.VERSION.SDK_INT)
            } else ai.impo.client.AppReleaseClient().check(BuildConfig.VERSION_CODE, android.os.Build.VERSION.SDK_INT)
        }
        setContent { ImpoTheme {
            val update by app.upgrade.available.collectAsState()
            ImpoApp(model)
            if (showHealthPrivacy) AlertDialog(onDismissRequest = { showHealthPrivacy = false },
                title = { Text("Your health data in Impo") },
                text = { Text("When you enable Health in Connections, Impo can read the health categories you permit to answer your requests. Requested summaries are sent to your Impo account for your personal agent to use. Impo does not write health records. You can turn this connection off or revoke access in Health Connect at any time. Missing samples are treated as unknown.") },
                confirmButton = { TextButton(onClick = { showHealthPrivacy = false }) { Text("Done") } },
                dismissButton = { TextButton(onClick = { ai.impo.ui.openWeb(this, "https://impo.ai/privacy/") }) { Text("Privacy policy") } })
            if (!showHealthPrivacy) update?.let { release ->
                AlertDialog(onDismissRequest = { app.upgrade.dismiss() },
                    title = { Text("Update available") },
                    text = { Text("Impo ${release.version} (${release.build}) is available. You can update now or keep using this version.") },
                    confirmButton = { TextButton(onClick = {
                        app.upgrade.dismiss()
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(release.url))) }
                    }) { Text("Update") } },
                    dismissButton = { TextButton(onClick = { app.upgrade.dismiss() }) { Text("Later") } })
            }
        } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleIntent(intent) }
    private fun handleIntent(intent: Intent) {
        (application as ImpoApplication).push.opened(intent)
        if (intent.action in setOf("androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE", "android.intent.action.VIEW_PERMISSION_USAGE")) showHealthPrivacy = true
        if (BuildConfig.CLERK_PUBLISHABLE_KEY.isNotBlank()) Clerk.auth.handle(intent.data)
        if (BuildConfig.DEBUG) intent.getStringExtra("impo.test.api")?.let { endpoint -> lifecycleScope.launch { model.auth.connectDevelopment(endpoint) } }
    }
    override fun onResume() { super.onResume(); (application as ImpoApplication).push.foreground(true); (application as ImpoApplication).echoSchedule.foreground(true); model.resumed() }
    override fun onStop() { (application as ImpoApplication).push.foreground(false); (application as ImpoApplication).echoSchedule.foreground(false); model.paused(); super.onStop() }
}
