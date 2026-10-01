package ai.impo.client

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class AppReleaseTest {
    private val release = """{"schemaVersion":1,"platform":"android","channel":"apk","latest":{"version":"0.1.5","build":6,"minimumSystemVersion":"28","url":"https://impo.ai/android.apk"}}"""
    @Test fun comparesBuildsNumericallyAndRejectsIncompatibleUnsafeAndWrongChannelData() {
        assertEquals(6, AppRelease.update(release, 5, 35)?.build)
        assertNull(AppRelease.update(release, 6, 35)); assertNull(AppRelease.update(release, 7, 35))
        for (raw in listOf("bad json", release.replace("android\"", "ios\""), release.replace("\"apk\"", "\"testflight\""), release.replace("impo.ai/android", "evil.test/android"), release.replace("\"28\"", "\"36\""), release.replace("\"build\":6", "\"build\":-1"), release.replace("\"schemaVersion\":1", "\"schemaVersion\":2")))
            assertNull(raw, AppRelease.update(raw, 5, 35))
    }
    @Test fun publicRequestSendsNoIdentityAndFailsOpenOnHttpHtmlAndLargeBodies() = runBlocking {
        MockWebServer().use { server ->
            val client = AppReleaseClient(server.url("/").toString())
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(release))
            assertEquals(6, client.check(5, 35)?.build)
            val request = server.takeRequest()
            assertEquals("/app-releases/android-apk.json", request.path)
            assertNull(request.getHeader("Authorization")); assertNull(request.getHeader("Cookie"))
            for (response in listOf(MockResponse().setResponseCode(503), MockResponse().setHeader("Content-Type", "text/html").setBody(release), MockResponse().setHeader("Content-Type", "application/json").setBody(" ".repeat(8193) + release))) {
                server.enqueue(response); assertNull(client.check(5, 35))
            }
        }
    }
}
