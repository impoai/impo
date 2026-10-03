package ai.impo.ui

import android.content.ContextWrapper
import android.content.Intent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.impo.client.ClientAction
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ClientActionsInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @Test fun onlyTapsLaunchTypedIntentsAndRecompositionDoesNotRepeatThem() {
        val opened = mutableListOf<Intent>()
        val context = object : ContextWrapper(InstrumentationRegistry.getInstrumentation().targetContext) {
            override fun startActivity(intent: Intent) { opened += intent }
        }
        fun action(name: String, parameters: JsonObject): ClientAction = checkNotNull(ClientAction.from(name, buildJsonObject {
            put("kind", "client_action"); put("schemaVersion", 1); put("actionId", java.util.UUID.randomUUID().toString())
            put("capability", name); put("execution", "device"); put("interaction", "tap"); put("status", "ready"); put("parameters", parameters)
        }))
        val link = action("impo_open_link", buildJsonObject { put("url", "https://youtu.be/example") })
        val directions = action("impo_navigate", buildJsonObject { put("destination", "Union Square, San Francisco"); put("mode", "walking") })
        val cards = mutableStateOf(listOf(link, directions))
        compose.setContent { CompositionLocalProvider(LocalContext provides context) { ImpoTheme { ClientActions(cards.value) } } }
        compose.runOnIdle { assertTrue(opened.isEmpty()) }
        compose.onNodeWithTag("message.action.impo_open_link").performClick()
        compose.runOnIdle { assertEquals(1, opened.size); assertEquals("https://youtu.be/example", opened.single().data.toString()); cards.value = listOf(directions, link) }
        compose.runOnIdle { assertEquals(1, opened.size) }
        compose.onNodeWithTag("message.action.impo_navigate").performClick()
        compose.runOnIdle {
            assertEquals(2, opened.size); assertEquals(Intent.ACTION_VIEW, opened.last().action)
            assertEquals("walking", opened.last().data!!.getQueryParameter("travelmode"))
        }
    }
}
