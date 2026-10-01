package ai.impo.data

import ai.impo.client.AppRelease
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceUntilIdle
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SoftUpgradeTest {
    @Test fun oneCheckPerProcessDismissSurvivesRecreationAndNextColdStartCanPrompt() = runTest {
        var calls = 0
        val load: suspend () -> AppRelease? = { calls++; AppRelease("0.1.5", 6, "https://impo.ai/android.apk", "28") }
        val process = SoftUpgrade()
        process.checkOnce(this, load); process.checkOnce(this, load); advanceUntilIdle()
        assertEquals(1, calls); assertNotNull(process.available.value)
        process.dismiss(); process.checkOnce(this, load); advanceUntilIdle()
        assertNull(process.available.value); assertEquals(1, calls)
        val cold = SoftUpgrade(); cold.checkOnce(this, load); advanceUntilIdle()
        assertNotNull(cold.available.value); assertEquals(2, calls)
    }
    @Test fun failureDoesNotBlockOrRetryOnResume() = runTest {
        val process = SoftUpgrade(); var calls = 0
        process.checkOnce(this) { calls++; error("Offline") }; advanceUntilIdle()
        process.checkOnce(this) { calls++; null }; advanceUntilIdle()
        assertEquals(1, calls); assertNull(process.available.value)
    }
}
