package ai.impo.ui

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import ai.impo.MainActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class) class ModelModeInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun modePersistsAcrossActivityRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3011")).use { scenario ->
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("settings.open").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("settings.open").performClick()
            compose.onNodeWithTag("settings.list").performScrollToNode(hasTestTag("settings.mode.power"))
            compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("settings.mode.power") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("settings.mode.power").performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("settings.mode.power") and isSelected() and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            scenario.recreate()
            compose.onNodeWithTag("settings.mode.power").performScrollTo().assertIsSelected()
            compose.onNodeWithTag("settings.mode.balanced").performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("settings.mode.balanced") and isSelected() and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        }
    }
}
