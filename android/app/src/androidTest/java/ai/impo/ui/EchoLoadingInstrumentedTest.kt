package ai.impo.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EchoLoadingInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun confirmedEmptyTimelineKeepsItsContentAndPositionDuringLaterRefreshes() {
        val loaded = mutableStateOf(false)
        val refreshing = mutableStateOf(true)
        compose.setContent { ImpoTheme { EchoTimelinePlaceholder(loaded.value, refreshing.value) } }
        compose.onNodeWithTag("echo.loading").assertIsDisplayed()
        compose.onNodeWithTag("echo.empty").assertDoesNotExist()

        compose.runOnIdle { loaded.value = true; refreshing.value = false }
        compose.onNodeWithTag("echo.empty").assertIsDisplayed()
        compose.onNodeWithTag("echo.loading").assertDoesNotExist()
        val settled = compose.onNodeWithTag("echo.empty").fetchSemanticsNode().boundsInRoot
        repeat(3) {
            compose.runOnIdle { refreshing.value = true }
            compose.onNodeWithTag("echo.empty").assertIsDisplayed()
            compose.onNodeWithTag("echo.loading").assertDoesNotExist()
            assertEquals(settled, compose.onNodeWithTag("echo.empty").fetchSemanticsNode().boundsInRoot)
            compose.runOnIdle { refreshing.value = false }
        }
    }

    @Test fun failedFirstLoadDoesNotClaimThereAreNoEchoesAndRetryReturnsToLoading() {
        val refreshing = mutableStateOf(false)
        val error = mutableStateOf<String?>(null)
        compose.setContent { ImpoTheme { Column {
            ErrorNotice(error.value) { refreshing.value = true; error.value = null }
            EchoTimelinePlaceholder(loaded = false, refreshing = refreshing.value)
        } } }
        // There is no empty-state flash before the initial request starts.
        compose.onNodeWithTag("echo.empty").assertDoesNotExist()
        compose.onNodeWithTag("echo.loading").assertDoesNotExist()
        compose.runOnIdle { refreshing.value = true }
        compose.onNodeWithTag("echo.loading").assertIsDisplayed()
        compose.runOnIdle { refreshing.value = false; error.value = "Couldn't load your timeline." }
        compose.onNodeWithText("Couldn't load your timeline.").assertIsDisplayed()
        compose.onNodeWithTag("echo.empty").assertDoesNotExist()
        compose.onNodeWithTag("echo.loading").assertDoesNotExist()
        compose.onNodeWithContentDescription("Retry").performClick()
        compose.onNodeWithTag("echo.loading").assertIsDisplayed()
        compose.onNodeWithText("Couldn't load your timeline.").assertDoesNotExist()
    }
}
