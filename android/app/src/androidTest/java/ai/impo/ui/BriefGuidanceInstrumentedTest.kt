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

@RunWith(AndroidJUnit4::class) class BriefGuidanceInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun suggestionsPreserveDraftsAndPreferencesPersist() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("impo.test.api", "http://127.0.0.1:3011")).use {
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("chat.input").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("chat.input").performTextInput("Keep my unfinished message")
            compose.onNodeWithTag("nav.brief").performClick()
            val actionTag = "brief.action.aaaaaaaaaaaaaaaaaaaaaaaa"
            compose.onNodeWithTag("brief.list").performScrollToNode(hasTestTag(actionTag))
            compose.onAllNodesWithTag(actionTag).onFirst().performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Keep current draft").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Keep current draft").performClick()
            compose.onNodeWithTag("chat.input").assertTextEquals("Keep my unfinished message")
            compose.onNodeWithTag("nav.brief").performClick()
            compose.onNodeWithTag("brief.list").performScrollToNode(hasTestTag(actionTag))
            compose.onAllNodesWithTag(actionTag).onFirst().performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithText("Replace draft").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("Replace draft").performClick()
            compose.onNodeWithTag("chat.input").assertTextEquals("Help me choose the smallest useful next step for my project.")
            compose.onNodeWithTag("nav.brief").performClick()
            compose.onNodeWithTag("brief.settings").performClick()
            compose.onNodeWithTag("briefSettings.category.feature").performScrollTo().performClick()
            compose.onNodeWithTag("briefSettings.save").performScrollTo().performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("brief.settings").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("brief.settings").performClick()
            compose.onNodeWithTag("briefSettings.category.feature").performScrollTo().assertIsOff()
        }
    }
}
