package ai.impo.ui

import ai.impo.client.BriefSlot
import org.junit.Assert.*
import org.junit.Test

class BriefSettingsValidationTest {
    private val slots = listOf(BriefSlot("morning", "Morning Brief", 8, true), BriefSlot("evening", "Evening Brief", 20, true))
    @Test fun disabledHoursCanOverlapButEnabledTimesCannot() {
        assertNotNull(validateBriefSettings("UTC", "en-US", slots.map { it.copy(hour = 8) }, "", ""))
        assertNull(validateBriefSettings("UTC", "en-US", listOf(slots[0], slots[1].copy(hour = 8, enabled = false)), "", ""))
        assertNull(validateBriefSettings("Asia/Shanghai", "zh-CN", slots.map { it.copy(enabled = false) }, "Shanghai", "China"))
    }
    @Test fun incompleteAndAmbiguousPreferencesCannotBeSaved() {
        assertNotNull(validateBriefSettings("invented/time", "en-US", slots, "", ""))
        assertNotNull(validateBriefSettings("UTC", "!", slots, "", ""))
        assertNotNull(validateBriefSettings("UTC", "en-US", emptyList(), "", ""))
        assertNotNull(validateBriefSettings("UTC", "en-US", slots + slots.first(), "", ""))
        assertNotNull(validateBriefSettings("UTC", "en-US", listOf(slots.first().copy(label = " ")), "", ""))
        assertNotNull(validateBriefSettings("UTC", "en-US", listOf(slots.first().copy(hour = 24)), "", ""))
        assertNotNull(validateBriefSettings("UTC", "en-US", slots, "Shanghai", ""))
    }
}
