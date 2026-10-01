package ai.impo.client

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class DeliveredFileTest {
    private val fileId = "3f1c2b7a-4d5e-4f60-8a9b-0c1d2e3f4a5b_artifact_036c9b83"

    @Test fun reducerCollectsFilesOnceAndIgnoresMalformedParts() {
        val reducer = UIMessageReducer()
        listOf(
            """{"type":"start","messageId":"assistant"}""",
            """{"type":"data-instant-file","id":"f1","data":{"schemaVersion":1,"fileId":"f1","name":"语言模型后训练.pdf","mediaType":"application/pdf","sizeBytes":102597}}""",
            """{"type":"data-instant-file","id":"f1","data":{"schemaVersion":1,"fileId":"f1","name":"语言模型后训练.pdf","mediaType":"application/pdf","sizeBytes":102597}}""",
            """{"type":"data-instant-file","id":"f2","data":{"schemaVersion":2,"fileId":"f2","name":"x.pdf","mediaType":"application/pdf","sizeBytes":1}}""",
            """{"type":"data-instant-file","id":"f3","data":{"schemaVersion":1,"fileId":"f3","name":"x.pdf","mediaType":"application/pdf","sizeBytes":"1"}}""",
            """{"type":"data-instant-file","data":false}""",
            """{"type":"finish"}""", "[DONE]",
        ).forEach(reducer::consume)
        assertEquals(listOf(DeliveredFile("f1", "语言模型后训练.pdf", "application/pdf", 102597)), reducer.state.files)
    }

    @Test fun historyPartsAndStreamPartsDescribeTheSameFile() {
        val page = ProtocolJson.decodeFromString<ConversationPage>("""{"conversationId":"c","messages":[{"id":"a","role":"assistant","sequence":2,"text":"Done","status":"completed","createdAt":"now","parts":[{"type":"text","text":"Done"},{"type":"data-instant-file","id":"f1","data":{"schemaVersion":1,"fileId":"f1","name":"report.xlsx","mediaType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","sizeBytes":12}}]}]}""")
        val file = page.messages.single().files.single()
        assertEquals("report.xlsx", file.name)
        assertEquals(file, ConversationMessage("a", "assistant", 2, "", "completed", "now", listOf(file.part())).files.single())
        assertEquals("_a_b_c.pdf", DeliveredFile("f", "../a/b:c.pdf", "", 0).localName)
        assertEquals("file", DeliveredFile("f", " . ", "", 0).localName)
    }

    @Test fun downloadStoresTheFileOnceAndReportsServerErrors() = runBlocking {
        val server = MockWebServer(); server.start()
        val directory = Files.createTempDirectory("delivered").toFile()
        try {
            val client = ImpoClient(server.url("/").toString(), StaticTokenProvider("token", "alice"), true)
            server.enqueue(MockResponse().setHeader("Content-Type", "application/pdf").setBody(Buffer().writeUtf8("%PDF-1.4")))
            val file = DeliveredFile(fileId, "后训练 指南.pdf", "application/pdf", 8)
            val stored = client.downloadFile(file, directory)
            assertEquals("后训练 指南.pdf", stored.name)
            assertEquals("%PDF-1.4", stored.readText())
            val request = server.takeRequest()
            assertEquals("/api/v1/files/$fileId", request.path)
            assertEquals("Bearer token", request.getHeader("Authorization"))
            // A second open reuses the stored copy without another request.
            assertEquals(stored, client.downloadFile(file, directory))
            assertEquals(1, server.requestCount)

            server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"File not found","retryable":false}}"""))
            val missing = DeliveredFile("${fileId}x", "gone.pdf", "application/pdf", 1)
            val error = runCatching { client.downloadFile(missing, directory) }.exceptionOrNull() as ApiException
            assertEquals(404, error.statusCode)
            assertEquals("not_found", error.code)
            assertTrue(java.io.File(directory, missing.fileId).listFiles().orEmpty().isEmpty())
        } finally { server.shutdown(); directory.deleteRecursively() }
    }

    @Test fun partialDownloadsInvalidPathsAndChangedAccountsCannotUseTheCache() = runBlocking {
        MockWebServer().use { server ->
            val directory = Files.createTempDirectory("delivered-isolation").toFile()
            var owner = "alice"
            val tokens = object : TokenProvider {
                override suspend fun token() = SessionToken(owner, "token")
                override suspend fun refresh(rejected: SessionToken) = token()
            }
            val client = ImpoClient(server.url("/").toString(), tokens, true)
            val file = DeliveredFile(fileId, "private.pdf", "application/pdf", 8)
            try {
                for (body in listOf("short", "too many bytes")) {
                    server.enqueue(MockResponse().setBody(body))
                    assertTrue(runCatching { client.downloadFile(file, directory) }.exceptionOrNull() is ProtocolException)
                    assertTrue(java.io.File(directory, fileId).listFiles().orEmpty().isEmpty())
                }
                assertTrue(runCatching { client.downloadFile(file.copy(fileId = "../outside"), directory) }.exceptionOrNull() is IllegalArgumentException)
                server.enqueue(MockResponse().setBody("%PDF-1.4"))
                client.downloadFile(file, directory)
                owner = "bob"
                assertTrue(runCatching { client.downloadFile(file, directory) }.exceptionOrNull() is AccountChangedException)
                assertEquals(3, server.requestCount)
            } finally { directory.deleteRecursively() }
        }
    }
}
