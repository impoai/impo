package ai.impo.data

import ai.impo.client.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.flow.*
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class AccountProfileSessionTest {
    private class Preferences : ProfilePreferences {
        val values = mutableMapOf<String, ProfileCache>()
        override suspend fun read(account: String) = values[account] ?: ProfileCache()
        override suspend fun update(account: String, change: (ProfileCache) -> ProfileCache): ProfileCache =
            change(read(account)).also { values[account] = it }
    }
    private class Api : ProfileApi {
        var profile = AccountProfile(false)
        var brief: BriefSettings? = null
        var readFailure: Exception? = null
        var loseProfileResponse = false
        var loseNameResponse = false
        var afterGet: suspend () -> Unit = {}
        var afterUpdate: suspend () -> Unit = {}
        var beforeUpdate: (ProfileUpdate) -> Unit = {}
        val patches = mutableListOf<ProfileUpdate>()
        val briefWrites = mutableListOf<BriefSettings>()
        var reads = 0
        override suspend fun get(): AccountProfile {
            reads++
            val snapshot = profile.copy(displayName = brief?.displayName ?: profile.displayName)
            afterGet()
            readFailure?.let { throw it }
            return snapshot
        }
        override suspend fun update(value: ProfileUpdate): AccountProfile {
            beforeUpdate(value)
            patches += value
            profile = profile.copy(onboarded = profile.onboarded || value.onboarded == true,
                assistantName = value.assistantName ?: profile.assistantName, avatarIndex = value.avatarIndex ?: profile.avatarIndex, mode = value.mode ?: profile.mode)
            afterUpdate()
            if (loseProfileResponse) { loseProfileResponse = false; throw IOException("Response was lost") }
            return profile
        }
        override suspend fun briefSettings() = brief
        override suspend fun updateBriefSettings(value: BriefSettings): BriefSettings {
            briefWrites += value
            brief = value
            if (loseNameResponse) { loseNameResponse = false; throw IOException("Name response was lost") }
            return value
        }
    }

    @Test fun modelModeSyncsAcrossDevicesAndRetriesWithoutOverwritingOtherProfileFields() = runTest {
        val preferences = Preferences()
        val api = Api().apply { profile = AccountProfile(true, assistantName = "Robin", mode = "Power") }
        val first = AccountProfileSession("alice", preferences, api, { true })
        first.restore()
        assertEquals("Power", first.state.value.settings.mode)
        api.loseProfileResponse = true
        assertFalse(first.save(first.state.value.settings.copy(mode = "Balanced")))
        assertEquals(ProfileUpdate(mode = "Balanced"), preferences.read("alice").pending)
        val reopened = AccountProfileSession("alice", preferences, api, { true })
        reopened.restore()
        assertEquals("Balanced", reopened.state.value.settings.mode)
        assertNull(preferences.read("alice").pending)
        assertEquals("Robin", reopened.state.value.settings.assistantName)
        val secondDevice = AccountProfileSession("alice", Preferences(), api, { true })
        secondDevice.restore()
        assertEquals("Balanced", secondDevice.state.value.settings.mode)
        val other = AccountProfileSession("bob", preferences, Api(), { true })
        other.restore()
        assertEquals("Balanced", other.state.value.settings.mode)
    }

    @Test fun returningAccountRestoresItsServerProfileAndKeepsDevicePermissionsLocal() = runTest {
        val preferences = Preferences()
        preferences.values["alice"] = ProfileCache(UserSettings(wifiOnly = true, calendarEnabled = true, contactsEnabled = true))
        val api = Api().apply { profile = AccountProfile(true, "Alex", "Robin", 1) }
        val session = AccountProfileSession("alice", preferences, api, { true })
        session.restore()
        assertTrue(session.state.value.loaded)
        assertEquals(UserSettings("Alex", "Robin", 1, onboarded = true, wifiOnly = true, calendarEnabled = true, contactsEnabled = true), session.state.value.settings)
        assertEquals(session.state.value.settings, preferences.read("alice").settings)
        val other = AccountProfileSession("bob", preferences, Api(), { true })
        other.restore()
        assertEquals(UserSettings(), other.state.value.settings)
        assertFalse(other.state.value.settings.onboarded)
        assertNotEquals(accountScope("alice"), accountScope("bob"))
    }

    @Test fun outageDoesNotTurnAnUnknownReturningAccountIntoNewOnboarding() = runTest {
        val preferences = Preferences()
        val api = Api().apply { readFailure = IOException("Offline") }
        val freshInstall = AccountProfileSession("alice", preferences, api, { true })
        freshInstall.restore()
        assertFalse(freshInstall.state.value.loaded)
        assertEquals("Offline", freshInstall.state.value.error)
        preferences.values["alice"] = ProfileCache(UserSettings(assistantName = "Wren", onboarded = true))
        val cached = AccountProfileSession("alice", preferences, api, { true })
        cached.restore()
        assertTrue(cached.state.value.loaded)
        assertEquals("Wren", cached.state.value.settings.assistantName)
        api.readFailure = null
        api.profile = AccountProfile(true, assistantName = "Restored")
        freshInstall.restore()
        assertTrue(freshInstall.state.value.loaded)
        assertNull(freshInstall.state.value.error)
        assertEquals("Restored", freshInstall.state.value.settings.assistantName)
    }

    @Test fun acceptedProfileWithLostResponseReplaysExactDurableEditAfterRestart() = runTest {
        val preferences = Preferences()
        val api = Api().apply { loseProfileResponse = true }
        val first = AccountProfileSession("alice", preferences, api, { true })
        api.beforeUpdate = { patch -> assertEquals(patch, preferences.values["alice"]?.pending) }
        assertFalse(first.save(UserSettings("Alex", "Wren", 2, onboarded = true, healthEnabled = true)))
        val saved = preferences.read("alice")
        assertTrue(saved.settings.onboarded)
        assertEquals("Alex", saved.pendingDisplayName)
        assertNotNull(saved.pending)
        val reopened = AccountProfileSession("alice", preferences, api, { true })
        reopened.restore()
        assertEquals(2, api.patches.size)
        assertEquals(api.patches[0], api.patches[1])
        assertNull(preferences.read("alice").pending)
        assertNull(preferences.read("alice").pendingDisplayName)
        assertEquals("Wren", reopened.state.value.settings.assistantName)
        assertTrue(reopened.state.value.settings.healthEnabled)
        assertNull(reopened.state.value.error)
    }

    @Test fun displayNameRetryPreservesLatestBriefScheduleLocaleAndLocation() = runTest {
        val preferences = Preferences()
        val original = BriefSettings("Asia/Tokyo", "ja-JP", "Previous", BriefLocation("Tokyo", "Japan", "2026-09-30T00:00:00.000Z", "manual"), listOf(BriefSlot("evening", "My evening", 21, true)))
        val api = Api().apply { brief = original; loseNameResponse = true; profile = AccountProfile(true) }
        preferences.values["alice"] = ProfileCache(UserSettings(displayName = "Previous", onboarded = true))
        val session = AccountProfileSession("alice", preferences, api, { true })
        session.restore()
        assertFalse(session.save(session.state.value.settings.copy(displayName = "Alex")))
        assertEquals(original.copy(displayName = "Alex"), api.briefWrites.single())
        assertEquals("Alex", preferences.read("alice").pendingDisplayName)
        // Another device changes Brief's schedule while this device is offline.
        api.brief = api.brief!!.copy(slots = listOf(BriefSlot("morning", "Early", 6, true)))
        val reopened = AccountProfileSession("alice", preferences, api, { true })
        reopened.restore()
        assertEquals(6, api.brief!!.slots.single().hour)
        assertEquals(original.location, api.brief!!.location)
        assertEquals("ja-JP", api.brief!!.locale)
        assertEquals("Alex", reopened.state.value.settings.displayName)
        assertNull(preferences.read("alice").pendingDisplayName)
        assertTrue(api.patches.isEmpty())
    }

    @Test fun fullLengthRemoteNameSurvivesPreferenceEditsAndNewNamesUseServerLimit() = runTest {
        val preferences = Preferences()
        val name = "A".repeat(100)
        val api = Api().apply { profile = AccountProfile(true, displayName = name) }
        val session = AccountProfileSession("alice", preferences, api, { true })
        session.restore()
        assertTrue(session.save(session.state.value.settings.copy(wifiOnly = true)))
        assertEquals(name, preferences.read("alice").settings.displayName)
        assertTrue(api.briefWrites.isEmpty())
        assertTrue(session.save(session.state.value.settings.copy(displayName = "B".repeat(101))))
        assertEquals("B".repeat(100), api.briefWrites.single().displayName)
        val fallback = AccountProfileSession("bob", preferences, Api(), { true }, fallbackName = "C".repeat(101))
        fallback.restore()
        assertEquals("C".repeat(100), fallback.state.value.settings.displayName)
    }

    @Test fun profileResponseFromOldLoginCannotOverwriteSameUsersNewLogin() = runTest {
        val preferences = Preferences()
        var generation = 1
        val release = CompletableDeferred<Unit>()
        val oldApi = Api().apply {
            profile = AccountProfile(true, assistantName = "Old result")
            afterGet = { withContext(NonCancellable) { release.await() } }
        }
        val old = AccountProfileSession("alice", preferences, oldApi, { generation == 1 })
        val oldJob = launch { old.restore() }
        runCurrent()
        generation = 2
        val current = AccountProfileSession("alice", preferences, Api().apply { profile = AccountProfile(true, assistantName = "New session") }, { generation == 2 })
        current.restore()
        release.complete(Unit)
        oldJob.join()
        assertEquals("New session", preferences.read("alice").settings.assistantName)
        assertEquals("New session", current.state.value.settings.assistantName)
        assertFalse(old.state.value.loaded)
    }

    @Test fun lateAcknowledgmentCannotClearTheNewLoginPendingChanges() = runTest {
        val preferences = Preferences()
        var generation = 1
        val release = CompletableDeferred<Unit>()
        val oldApi = Api().apply { afterUpdate = { withContext(NonCancellable) { release.await() } } }
        val old = AccountProfileSession("alice", preferences, oldApi, { generation == 1 })
        val oldJob = launch { old.save(UserSettings(assistantName = "First")) }
        runCurrent()
        generation = 2
        val current = AccountProfileSession("alice", preferences, Api().apply { loseProfileResponse = true }, { generation == 2 })
        assertFalse(current.save(UserSettings(assistantName = "Second")))
        release.complete(Unit)
        oldJob.join()
        assertEquals("Second", preferences.read("alice").settings.assistantName)
        assertEquals("Second", preferences.read("alice").pending?.assistantName)
    }

    @Test fun avatarMigrationPreservesEachOldLookAndNeverReinterpretsNewCache() {
        val shared = listOf(3, 0, 1, 2, 4, 5)
        shared.forEachIndexed { old, expected ->
            val migrated = decodeProfileCache(null, """{"avatar":$old,"onboarded":true,"calendarEnabled":true}""")
            assertEquals(expected, migrated.settings.avatar)
            assertTrue(migrated.settings.onboarded)
            assertTrue(migrated.settings.calendarEnabled)
            assertEquals(migrated, decodeProfileCache(ProtocolJson.encodeToString(migrated), """{"avatar":$old}"""))
        }
        assertEquals(3, decodeProfileCache(null, "{}").settings.avatar)
        assertEquals(3, decodeProfileCache(null, null).settings.avatar)
    }

    @Test fun missingIosCustomPhotoKeepsLocalLookAndPreferenceSaveDoesNotOverwriteRemotePhoto() = runTest {
        val preferences = Preferences()
        preferences.values["alice"] = ProfileCache(UserSettings(avatar = 2, onboarded = true))
        val api = Api().apply { profile = AccountProfile(true, avatarIndex = 6) }
        val session = AccountProfileSession("alice", preferences, api, { true })
        session.restore()
        assertEquals(2, session.state.value.settings.avatar)
        assertTrue(session.save(session.state.value.settings.copy(calendarEnabled = true, contactsEnabled = true)))
        assertTrue(api.patches.isEmpty())
        assertEquals(6, api.profile.avatarIndex)
    }

    @Test fun developmentUsesRealProfileRoutesAndCanStillOpenOlderLocalBackend() = runTest {
        val api = Api().apply { profile = AccountProfile(true, assistantName = "Fixture account") }
        val session = AccountProfileSession("development", Preferences(), api, { true }, development = true)
        session.restore()
        assertEquals(1, api.reads)
        assertEquals("Fixture account", session.state.value.settings.assistantName)
        assertTrue(session.save(session.state.value.settings.copy(assistantName = "Edited")))
        assertEquals("Edited", api.patches.single().assistantName)
        val unavailable = AccountProfileSession("old-server", Preferences(), Api().apply { readFailure = IOException("503") }, { true }, development = true)
        unavailable.restore()
        assertTrue(unavailable.state.value.loaded)
        assertNotNull(unavailable.state.value.error)
    }

    @Test fun tokenOwnerRejectsSameUserNewSessionOrEndpointBeforeAndAfterRefresh() {
        val original = Account("alice", "Alex", null, "https://api.example", false, "session-1")
        original.requireCurrent(original, "alice", "session-1")
        listOf(original.copy(sessionId = "session-2"), original.copy(id = "bob"), original.copy(baseUrl = "https://other.example")).forEach { current ->
            assertThrows(AccountChangedException::class.java) { original.requireCurrent(current, current.id, current.sessionId) }
        }
        assertThrows(AccountChangedException::class.java) { original.requireCurrent(original, "alice", "session-2") }
        assertThrows(AccountChangedException::class.java) { original.requireCurrent(null, null, null) }
    }

    @Test fun queuedPreferenceEditCannotUndoNameSavedFromTheSameUiSnapshot() = runTest {
        val preferences = Preferences()
        val release = CompletableDeferred<Unit>()
        val api = Api().apply { afterUpdate = { release.await() } }
        val session = AccountProfileSession("alice", preferences, api, { true })
        session.restore()
        val baseline = session.state.value.settings
        val nameSave = async { session.save(baseline.copy(assistantName = "Wren"), baseline) }
        runCurrent()
        val permissionSave = async { session.save(baseline.copy(contactsEnabled = true), baseline) }
        runCurrent()
        assertTrue(permissionSave.isCompleted)
        assertFalse(nameSave.isCompleted)
        release.complete(Unit)
        assertTrue(nameSave.await())
        assertTrue(permissionSave.await())
        assertEquals("Wren", preferences.read("alice").settings.assistantName)
        assertTrue(preferences.read("alice").settings.contactsEnabled)
        assertEquals(1, api.patches.size)
    }

    @Test fun policyRevocationDoesNotWaitForEarlierProfileNetworkAndSurvivesItsAcknowledgment() = runTest {
        val preferences = Preferences()
        preferences.values["alice"] = ProfileCache(UserSettings(onboarded = true, recordingLocation = true, contactsEnabled = true))
        val release = CompletableDeferred<Unit>()
        val api = Api().apply { profile = AccountProfile(true); afterUpdate = { release.await() } }
        val session = AccountProfileSession("alice", preferences, api, { true })
        session.restore()
        val baseline = session.state.value.settings
        val profileSave = async { session.save(baseline.copy(assistantName = "Wren"), baseline) }
        runCurrent()
        assertFalse(profileSave.isCompleted)
        assertTrue(session.save(baseline.copy(contactsEnabled = false, recordingLocation = false, wifiOnly = true), baseline))
        assertFalse(session.state.value.settings.contactsEnabled)
        assertFalse(session.state.value.settings.recordingLocation)
        assertTrue(session.state.value.settings.wifiOnly)
        assertEquals("Wren", preferences.read("alice").pending?.assistantName)
        release.complete(Unit)
        assertTrue(profileSave.await())
        assertFalse(preferences.read("alice").settings.contactsEnabled)
        assertFalse(session.state.value.settings.recordingLocation)
        assertTrue(session.state.value.settings.wifiOnly)
    }

    @Test fun localPrivacyPolicyChangesPublishBeforeSlowRemoteProfileAcknowledgment() = runTest {
        val preferences = Preferences()
        preferences.values["alice"] = ProfileCache(UserSettings(onboarded = true, recordingLocation = true))
        val release = CompletableDeferred<Unit>()
        val api = Api().apply { profile = AccountProfile(true); afterUpdate = { release.await() } }
        val session = AccountProfileSession("alice", preferences, api, { true })
        val observed = mutableListOf<Pair<Boolean, Boolean>>()
        val collector = backgroundScope.launch { session.state.filter { it.localLoaded }.map { it.settings.wifiOnly to it.settings.recordingLocation }.distinctUntilChanged().collect { observed += it } }
        runCurrent()
        assertTrue(observed.isEmpty()) // Placeholder defaults never change native policies.
        session.restore()
        runCurrent()
        val saving = async { session.save(session.state.value.settings.copy(assistantName = "Wren", wifiOnly = true, recordingLocation = false)) }
        runCurrent()
        assertFalse(saving.isCompleted)
        assertEquals(true to false, observed.last())
        assertTrue(preferences.read("alice").settings.wifiOnly)
        assertFalse(preferences.read("alice").settings.recordingLocation)
        release.complete(Unit)
        assertTrue(saving.await())
        collector.cancel()
    }
}
