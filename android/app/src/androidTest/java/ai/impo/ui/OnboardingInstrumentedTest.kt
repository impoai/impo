package ai.impo.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import ai.impo.data.UserSettings
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OnboardingInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @Test fun personalizationUsesNativeFieldsAndPassesTrimmedPreferencesToPersistence() {
        var saved: UserSettings? = null
        compose.setContent { ImpoTheme { PersonalizeScreen(UserSettings()) { saved = it } } }
        compose.onNodeWithTag("onboarding.name").performTextInput("  Android Tester  ")
        compose.onNodeWithTag("onboarding.assistant").performTextReplacement("  Robin  ")
        compose.onNodeWithTag("onboarding.continue").performScrollTo().performClick()
        compose.runOnIdle { assertEquals("Android Tester", saved?.displayName); assertEquals("Robin", saved?.assistantName) }
    }
}
