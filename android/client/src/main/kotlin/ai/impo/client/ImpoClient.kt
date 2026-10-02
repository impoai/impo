package ai.impo.client

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.job
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

val ProtocolJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

data class SessionToken(val accountId: String, val value: String) {
    init { require(accountId.isNotBlank()); require(value.isNotBlank() && value.none { it == '\r' || it == '\n' }) }
    override fun toString() = "SessionToken(accountId=$accountId, value=<redacted>)"
}
interface TokenProvider {
    suspend fun token(): SessionToken
    suspend fun refresh(rejected: SessionToken): SessionToken
}
class StaticTokenProvider(private val value: String, private val accountId: String = "local-development") : TokenProvider {
    override suspend fun token() = SessionToken(accountId, value)
    override suspend fun refresh(rejected: SessionToken) = token()
}
class AccountChangedException : CancellationException("The signed-in account changed")
class ApiException(
    val statusCode: Int, val code: String, override val message: String, val retryable: Boolean = false,
    val requestId: String? = null, val retryAfter: String? = null,
) : IOException(message)
class ProtocolException(message: String) : IOException(message)

/** Application transport only. A stream subscription never owns or cancels server execution. */
class ImpoClient(
    baseUrl: String,
    private val tokenProvider: TokenProvider,
    allowInsecureLocalhost: Boolean = false,
    httpClient: OkHttpClient = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build(),
) {
    private val base = baseUrl.toHttpUrl().also { validateBaseUrl(it, allowInsecureLocalhost) }
    private val http = httpClient.newBuilder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    // Browsers/background pauses can outlive server keep-alive. Only reads may
    // transparently recover a stale pooled connection; commands keep their explicit retry policy.
    private val queryHttp = http.newBuilder().retryOnConnectionFailure(true).build()
    // Deliberately independent: no application interceptors, cookies, authenticator or credentials.
    private val uploadHttp = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).build()
    private val insecureLocalUploads = allowInsecureLocalhost
    private val refreshMutex = Mutex()
    private val boundAccount = java.util.concurrent.atomic.AtomicReference<String?>(null)

    suspend fun currentAccountId(): String = checkedSession().accountId
    suspend fun prepareAccountDeletion(): AccountDeletionChallenge = send("POST", listOf("account", "deletion-challenge"), buildJsonObject {})
    suspend fun deleteAccount(challenge: AccountDeletionChallenge, confirmation: String): AccountDeletionReceipt =
        send("DELETE", listOf("account"), buildJsonObject {
            put("challengeId", challenge.challengeId); put("token", challenge.token); put("confirmation", confirmation)
        }, expected = 202)
    suspend fun accountDeletionStatus(requestId: String): AccountDeletionReceipt = get(listOf("account", "deletions", identifier(requestId)))
    suspend fun notificationPreferences(): NotificationPreferences = get(listOf("notifications", "settings"))
    suspend fun echoSchedule(): EchoSchedule = get<EchoSchedule>(listOf("echo", "schedule")).also { if (!it.isValid) throw ProtocolException("Invalid Echo schedule") }
    suspend fun saveEchoSchedule(value: EchoSchedule): EchoSchedule {
        require(value.isValid)
        val body = ProtocolJson.encodeToJsonElement(value).jsonObject.toMutableMap()
        body["revision"] = value.revision?.let(::JsonPrimitive) ?: JsonNull
        return send<EchoSchedule>("PUT", listOf("echo", "schedule"), JsonObject(body)).also { if (!it.isValid) throw ProtocolException("Invalid Echo schedule") }
    }
    private fun scheduleBody(value: ScheduledTaskInput): MutableMap<String, JsonElement> {
        val body = ProtocolJson.encodeToJsonElement(value).jsonObject.toMutableMap()
        val schedule = ProtocolJson.encodeToJsonElement(value.schedule).jsonObject.toMutableMap()
        schedule["runAt"] = value.schedule.runAt?.let(::JsonPrimitive) ?: JsonNull
        schedule["time"] = value.schedule.time?.let(::JsonPrimitive) ?: JsonNull
        body["schedule"] = JsonObject(schedule)
        return body
    }
    suspend fun scheduledTasks(): List<ScheduledTask> = get<ScheduledTasksResponse>(listOf("scheduled-tasks")).schedules
    suspend fun scheduledTask(id: String): ScheduledTask = get(listOf("scheduled-tasks", identifier(id)))
    suspend fun createScheduledTask(value: ScheduledTaskInput, clientRequestId: String): ScheduledTask {
        val body = scheduleBody(value)
        body["clientRequestId"] = JsonPrimitive(clientRequestId)
        return send("POST", listOf("scheduled-tasks"), JsonObject(body), expected = 201)
    }
    suspend fun updateScheduledTask(id: String, revision: String, value: ScheduledTaskInput): ScheduledTask {
        val body = scheduleBody(value)
        body["revision"] = JsonPrimitive(revision)
        return send("PUT", listOf("scheduled-tasks", identifier(id)), JsonObject(body))
    }
    suspend fun deleteScheduledTask(id: String, revision: String) {
        send<ScheduleDeletionReceipt>("DELETE", listOf("scheduled-tasks", identifier(id)), buildJsonObject { put("revision", revision) })
    }
    suspend fun scheduledTaskRuns(id: String, before: String? = null): ScheduledTaskRunPage = get(listOf("scheduled-tasks", identifier(id), "runs"), query("before" to before))
    suspend fun updateNotificationPreference(category: String, enabled: Boolean): NotificationPreferences {
        require(category in setOf("chat", "tasks", "scheduledTasks", "brief", "echo"))
        return send("PATCH", listOf("notifications", "settings"), buildJsonObject { put(category, enabled) })
    }
    suspend fun registerPush(installationId: String, installationSecret: String, revision: Long, registrationId: String, token: String?, enabled: Boolean, foreground: Boolean): PushRegistrationReceipt =
        send("PUT", listOf("notifications", "installations", identifier(installationId)), buildJsonObject {
            put("installationSecret", installationSecret); put("revision", revision); put("registrationId", registrationId); put("platform", "android")
            put("token", token?.let(::JsonPrimitive) ?: JsonNull); put("enabled", enabled); put("foreground", foreground)
        })
    suspend fun revokePush(installationId: String, installationSecret: String, revision: Long, registrationId: String): PushRevocationReceipt =
        send("DELETE", listOf("notifications", "installations", identifier(installationId)), buildJsonObject {
            put("installationSecret", installationSecret); put("revision", revision); put("registrationId", registrationId)
        })
    fun cancelInFlight() { http.dispatcher.cancelAll(); uploadHttp.dispatcher.cancelAll() }

    suspend fun profile(): AccountProfile = get(listOf("profile"))
    suspend fun updateProfile(value: ProfileUpdate): AccountProfile =
        send("PATCH", listOf("profile"), ProtocolJson.encodeToJsonElement(value))

    suspend fun conversation(afterSequence: Int = 0, limit: Int = 100): ConversationPage =
        get(listOf("conversation"), historyQuery(afterSequence, limit))
    suspend fun sendMessage(command: MessageCommand, deviceId: String? = null): MessageReceipt {
        val body = ProtocolJson.encodeToJsonElement(command).jsonObject.toMutableMap()
        deviceId?.let { body["deviceId"] = JsonPrimitive(identifier(it)) }
        return send("POST", listOf("conversation", "messages"), JsonObject(body), expected = 202)
    }
    suspend fun sendVoiceMessage(command: VoiceMessageCommand, deviceId: String? = null): VoiceMessageReceipt {
        val body = ProtocolJson.encodeToJsonElement(command).jsonObject.toMutableMap()
        deviceId?.let { body["deviceId"] = JsonPrimitive(identifier(it)) }
        return send<VoiceMessageReceipt>("POST", listOf("conversation", "voice-messages"), JsonObject(body), expected = 202).also {
            if (it.messageId.isBlank() || it.submissionId.isBlank()) throw ProtocolException("Voice response is missing its receipt")
            validateVoiceText(it.text)
        }
    }
    /** Draft-only transcription: no message or agent run is accepted by this route. */
    suspend fun transcribeVoice(clip: VoiceClip): String = validateVoiceText(
        send<VoiceTranscription>("POST", listOf("voice", "transcriptions"), ProtocolJson.encodeToJsonElement(clip)).text)
    suspend fun tasks(): List<TaskSummary> = get<TasksResponse>(listOf("tasks")).tasks
    suspend fun createTask(command: MessageCommand): TaskReceipt {
        require(command.text.length <= 4000)
        return send("POST", listOf("tasks"), ProtocolJson.encodeToJsonElement(command), expected = 202)
    }
    suspend fun taskConversation(taskId: String, afterSequence: Int = 0, limit: Int = 100): TaskConversationPage =
        get(listOf("tasks", identifier(taskId), "conversation"), historyQuery(afterSequence, limit))
    suspend fun sendTaskMessage(taskId: String, command: MessageCommand): MessageReceipt =
        send("POST", listOf("tasks", identifier(taskId), "messages"), ProtocolJson.encodeToJsonElement(command), expected = 202)
    suspend fun submission(submissionId: String): Submission = get(listOf("submissions", identifier(submissionId)))
    suspend fun cancelSubmission(submissionId: String): Submission = send("POST", listOf("submissions", identifier(submissionId), "cancel"))

    /** A fresh reducer per collection replaces replayed text, rather than appending it. */
    fun streamSubmission(submissionId: String): Flow<StreamState> = flow {
        val session = checkedSession()
        val request = request("GET", listOf("submissions", identifier(submissionId), "stream"), null, emptyMap())
            .newBuilder().header("Accept", "text/event-stream").build()
        val exchange = authorizedResponse(request, session)
        val response = exchange.response
        response.use {
            if (it.code != 200) throw decodeError(it)
            if (it.header("Content-Type")?.substringBefore(';')?.trim()?.lowercase() != "text/event-stream" ||
                it.header("x-vercel-ai-ui-message-stream") != "v1") throw ProtocolException("Unsupported message stream")
            val source = it.body?.source() ?: throw ProtocolException("Stream response has no body")
            val parser = SseParser()
            val reducer = UIMessageReducer()
            val buffer = ByteArray(8192)
            // Call.cancel() safely interrupts a blocking read; the reader alone closes the body.
            coroutineScope {
            val readingJob = currentCoroutineContext().job
            val cancellation = launch(start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() } finally { if (readingJob.isCancelled) exchange.call.cancel() }
            }
            try {
                while (true) {
                    currentCoroutineContext().ensureActive()
                    assertAccount(session)
                    val count = try { source.read(buffer) } catch (error: IOException) {
                        currentCoroutineContext().ensureActive()
                        throw error
                    }
                    if (count == -1) break
                    for (event in parser.feed(buffer, count)) emit(reducer.consume(event))
                    if (reducer.state.done) break
                }
                parser.validateEOF()
                reducer.validateEOF()
            } finally { cancellation.cancel() }
            }
        }
    }.flowOn(Dispatchers.IO)

    /**
     * Downloads a delivered file once into `directory/<fileId>/<name>`. The caller owns the
     * directory and clears it when the account changes.
     */
    suspend fun downloadFile(file: DeliveredFile, directory: File): File = withContext(Dispatchers.IO) {
        require(file.fileId.matches(Regex("[A-Za-z0-9_-]{1,256}"))) { "Invalid file identifier" }
        require(file.sizeBytes in 0..104_857_600L) { "File is too large to download" }
        val session = checkedSession()
        val folder = File(directory, identifier(file.fileId))
        val destination = File(folder, file.localName)
        if (destination.isFile && destination.length() == file.sizeBytes) { assertAccount(session); return@withContext destination }
        if (destination.exists() && !destination.delete()) throw IOException("Cannot replace an incomplete file")
        val exchange = authorizedResponse(request("GET", listOf("files", identifier(file.fileId)), null, emptyMap()), session)
        check(folder.isDirectory || folder.mkdirs()) { "Cannot prepare the file directory" }
        val staged = File(folder, ".${UUID.randomUUID()}.part")
        try {
            exchange.response.use {
                if (it.code != 200) throw decodeError(it)
                val body = it.body ?: throw ProtocolException("Response has no body")
                coroutineScope {
                    val readingJob = currentCoroutineContext().job
                    val closeOnCancel = launch(start = CoroutineStart.UNDISPATCHED) {
                        try { awaitCancellation() } finally { if (readingJob.isCancelled) exchange.call.cancel() }
                    }
                    try { staged.outputStream().use { output ->
                        val input = body.byteStream(); val buffer = ByteArray(8192); var size = 0L
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val read = input.read(buffer); if (read < 0) break
                            size += read
                            if (size > file.sizeBytes) throw ProtocolException("File size exceeded its metadata")
                            output.write(buffer, 0, read)
                        }
                        if (size != file.sizeBytes) throw ProtocolException("File download was incomplete")
                    } }
                    catch (error: IOException) { currentCoroutineContext().ensureActive(); throw error }
                    finally { closeOnCancel.cancel() }
                }
            }
            assertAccount(session)
            if (!destination.isFile && !staged.renameTo(destination)) throw IOException("Cannot store the downloaded file")
            destination
        } finally { staged.delete() }
    }

    suspend fun briefSettings(): BriefSettings? = get<SettingsResponse>(listOf("today", "settings")).settings
    /** Full replacement of editable fields; null location explicitly clears it. */
    suspend fun updateBriefSettings(settings: BriefSettings): BriefSettings {
        val body = ProtocolJson.encodeToJsonElement(settings).jsonObject.toMutableMap()
        if (settings.location == null) body["location"] = JsonNull
        return send<SettingsResponse>("PUT", listOf("today", "settings"), JsonObject(body)).settings
            ?: throw ProtocolException("Settings response is missing settings")
    }
    suspend fun briefs(limit: Int = 10, cursor: String? = null, date: String? = null): BriefPage {
        require(limit in 1..30)
        return get(listOf("today", "briefs"), query("limit" to limit.toString(), "cursor" to cursor, "date" to date))
    }
    suspend fun brief(briefId: String): Brief = get(listOf("today", "briefs", identifier(briefId)))
    suspend fun briefSource(briefId: String, recordId: String): BriefSource =
        get(listOf("today", "briefs", identifier(briefId), "sources", identifier(recordId)))
    suspend fun deleteBrief(briefId: String) { delete(listOf("today", "briefs", identifier(briefId)), "deleted") }
    suspend fun memorySummary(): MemorySummary = get(listOf("memories", "summary"))
    suspend fun memories(category: String? = null, cursor: String? = null, limit: Int = 30): MemoryPage {
        require(limit in 1..100)
        return get(listOf("memories"), query("category" to category, "cursor" to cursor, "limit" to limit.toString()))
    }
    suspend fun deleteMemory(memoryId: String) { delete(listOf("memories", identifier(memoryId)), "deleted") }
    suspend fun connectors(): List<Connector> = get<ConnectorsResponse>(listOf("connectors")).connectors
    suspend fun connectorStatus(toolkit: String): ConnectorStatus = get(listOf("connectors", toolkit(toolkit)))
    suspend fun connectConnector(toolkit: String): ConnectorAuthorization = send("POST", listOf("connectors", toolkit(toolkit), "connect"))
    suspend fun refreshConnector(toolkit: String): ConnectorStatus = send("POST", listOf("connectors", toolkit(toolkit), "refresh"))
    suspend fun disconnectConnector(toolkit: String) { delete(listOf("connectors", toolkit(toolkit)), "disconnected") }
    suspend fun echoTimeline(timeZone: String): EchoTimeline = get(listOf("listening", "timeline"), query("timeZone" to timeZone))
    suspend fun echoCalendar(timeZone: String): EchoCalendar = get(listOf("listening", "calendar"), query("timeZone" to timeZone))
    suspend fun echoRecords(ids: List<String>): List<EchoRecord> {
        require(ids.size <= 180)
        if (ids.isEmpty()) return emptyList()
        return get<EchoPage>(listOf("listening", "segments"), query("ids" to ids.map(::identifier).joinToString(","))).segments
    }
    suspend fun echoHistory(cursor: String? = null, limit: Int = 30, before: String? = null, newer: Boolean = false): EchoPage {
        require(limit in 1..100 && (cursor == null || before == null) && (!newer || cursor != null))
        return get(listOf("listening", "segments"), query("limit" to limit.toString(), "cursor" to cursor, "before" to before, "direction" to if (newer) "newer" else null))
    }
    suspend fun echoRecordsBetween(from: String, to: String): List<EchoRecord> =
        get<EchoPage>(listOf("listening", "segments"), query("from" to from, "to" to to)).segments
    suspend fun updateEchoLabel(recordId: String, label: String?): EchoRecord {
        require(label == null || (label.length <= 80 && label.none { it.isISOControl() }))
        return send<SegmentResponse>("PATCH", listOf("listening", "segments", identifier(recordId), "location"), buildJsonObject { put("label", label?.let(::JsonPrimitive) ?: JsonNull) }).segment
    }
    suspend fun deleteEchoRecord(recordId: String) { delete(listOf("listening", "segments", identifier(recordId)), "deleted") }
    suspend fun reviewEchoSpeakers(recordId: String, review: EchoSpeakerReview): EchoRecord =
        send<SegmentResponse>("PATCH", listOf("listening", "segments", identifier(recordId), "speakers"), ProtocolJson.encodeToJsonElement(review)).segment
    suspend fun prepareAudioUpload(manifest: UploadManifest): UploadTicket = send("POST", listOf("listening", "uploads"), ProtocolJson.encodeToJsonElement(manifest))
    suspend fun completeAudioUpload(batchId: String): BatchReceipt = send("POST", listOf("listening", "uploads", identifier(batchId), "complete"), expected = 202)
    suspend fun batchStatus(batchId: String): BatchStatus = get(listOf("listening", "batches", identifier(batchId)))
    suspend fun retryBatch(batchId: String) {
        val status = send<StatusResponse>("POST", listOf("listening", "batches", identifier(batchId), "retry"), expected = 202)
        if (status.status != "retry_requested") throw ProtocolException("Unknown batch retry acknowledgment")
    }
    suspend fun registerDevice(installationId: String, tools: List<String> = emptyList()): RegisteredDevice =
        send("POST", listOf("devices", "register"), buildJsonObject { put("installationId", identifier(installationId)); put("tools", JsonArray(tools.map(::JsonPrimitive))) })
    suspend fun pendingDeviceInvocations(deviceId: String): List<DeviceInvocation> =
        get<InvocationsResponse>(listOf("devices", identifier(deviceId), "tool-invocations"), query("status" to "pending")).invocations
    suspend fun claimDeviceInvocation(invocationId: String, deviceId: String): ToolClaim = send("POST", listOf("device-tool-invocations", identifier(invocationId), "claim"), buildJsonObject { put("deviceId", identifier(deviceId)) })
    suspend fun submitDeviceResult(invocationId: String, result: DeviceResult): ToolResultReceipt = send("POST", listOf("device-tool-invocations", identifier(invocationId), "result"), ProtocolJson.encodeToJsonElement(result))

    suspend fun uploadAudio(ticket: UploadTicket, exactBytes: ByteArray) = withContext(Dispatchers.IO) {
        require(ticket.status == "upload")
        val url = ticket.url?.toHttpUrl() ?: throw ProtocolException("Upload ticket is missing a URL")
        validateBaseUrl(url, insecureLocalUploads, allowQuery = true)
        val builder = Request.Builder().url(url).put(exactBytes.toRequestBody())
        ticket.headers.forEach { (name, value) ->
            if (name.equals("authorization", true) || name.equals("cookie", true) || name.equals("proxy-authorization", true) || name.equals("host", true))
                throw ProtocolException("Upload ticket attempted to set a credential or routing header")
            builder.header(name, value)
        }
        uploadHttp.newCall(builder.build()).awaitResponse().use { if (!it.isSuccessful) throw ApiException(it.code, "upload_http_error", "Audio upload failed (HTTP ${it.code})", it.code == 429 || it.code >= 500) }
    }

    private suspend inline fun <reified T> get(path: List<String>, query: Map<String, String> = emptyMap()): T = send("GET", path, null, query)
    private suspend inline fun <reified T> send(method: String, path: List<String>, body: JsonElement? = JsonObject(emptyMap()), query: Map<String, String> = emptyMap(), expected: Int = 200): T = withContext(Dispatchers.IO) {
        val session = checkedSession()
        val exchange = authorizedResponse(request(method, path, body, query), session)
        exchange.response.use {
            if (it.code != expected) throw decodeError(it)
            val source = it.body ?: throw ProtocolException("Response has no body")
            val raw = coroutineScope {
                val readingJob = currentCoroutineContext().job
                val closeOnCancel = launch(start = CoroutineStart.UNDISPATCHED) {
                    try { awaitCancellation() } finally { if (readingJob.isCancelled) exchange.call.cancel() }
                }
                try { source.string() }
                catch (error: IOException) { currentCoroutineContext().ensureActive(); throw error }
                finally { closeOnCancel.cancel() }
            }
            assertAccount(session)
            try { ProtocolJson.decodeFromString<T>(raw) } catch (error: kotlinx.serialization.SerializationException) { throw ProtocolException("Malformed application response") }
        }
    }
    private suspend fun delete(path: List<String>, expectedStatus: String) {
        val result = send<StatusResponse>("DELETE", path, null)
        if (result.status != expectedStatus) throw ProtocolException("Unknown deletion acknowledgment")
    }
    private fun request(method: String, path: List<String>, body: JsonElement?, query: Map<String, String>): Request {
        val url = base.newBuilder().apply {
            if (base.encodedPath.endsWith('/')) removePathSegment(base.pathSegments.lastIndex)
            addPathSegment("api"); addPathSegment("v1")
            path.forEach { addPathSegment(it) }
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        return Request.Builder().url(url).method(method, if (method == "GET" || (method == "DELETE" && body == null)) null else (body ?: JsonObject(emptyMap())).toString().toRequestBody("application/json; charset=utf-8".toMediaType())).build()
    }
    private data class AuthorizedResponse(val call: Call, val response: Response)
    private suspend fun authorizedResponse(request: Request, session: SessionToken): AuthorizedResponse {
        assertAccount(session)
        val transport = if (request.method == "GET") queryHttp else http
        val call = transport.newCall(request.newBuilder().header("Authorization", "Bearer ${session.value}").build())
        val response = call.awaitResponse()
        if (response.code != 401) return AuthorizedResponse(call, response)
        response.close()
        val refreshed = refreshMutex.withLock {
            val latest = tokenProvider.token()
            if (latest.accountId != session.accountId) throw AccountChangedException()
            if (latest.value != session.value) latest else tokenProvider.refresh(session)
        }
        if (refreshed.accountId != session.accountId) throw AccountChangedException()
        assertAccount(session)
        val refreshedCall = transport.newCall(request.newBuilder().header("Authorization", "Bearer ${refreshed.value}").build())
        return AuthorizedResponse(refreshedCall, refreshedCall.awaitResponse())
    }
    private suspend fun checkedSession(): SessionToken {
        val session = tokenProvider.token()
        boundAccount.compareAndSet(null, session.accountId)
        if (boundAccount.get() != session.accountId) throw AccountChangedException()
        return session
    }
    private suspend fun assertAccount(session: SessionToken) {
        currentCoroutineContext().ensureActive()
        if (tokenProvider.token().accountId != session.accountId) throw AccountChangedException()
    }
    private fun decodeError(response: Response): ApiException {
        val envelope = runCatching { ProtocolJson.parseToJsonElement(response.body?.string().orEmpty()).jsonObject }.getOrNull()
        val error = envelope?.get("error") as? JsonObject
        return ApiException(response.code, (error?.get("code") as? JsonPrimitive)?.contentOrNull ?: "http_error",
            (error?.get("message") as? JsonPrimitive)?.contentOrNull ?: "Request failed (HTTP ${response.code})",
            (error?.get("retryable") as? JsonPrimitive)?.booleanOrNull ?: (response.code == 429 || response.code >= 500),
            (envelope?.get("requestId") as? JsonPrimitive)?.contentOrNull ?: response.header("X-Request-Id"), response.header("Retry-After"))
    }
    private fun historyQuery(after: Int, limit: Int): Map<String, String> { require(after >= 0 && limit in 1..100); return query("afterSequence" to after.toString(), "limit" to limit.toString()) }
    private fun toolkit(value: String): String { require(Regex("[a-z0-9_]{1,64}").matches(value)); return value }
    private fun identifier(value: String): String { require(value.isNotBlank() && value.length <= 256 && '\u0000' !in value && value != "." && value != ".."); return value }
    private fun query(vararg entries: Pair<String, String?>): Map<String, String> = entries.mapNotNull { (key, value) -> value?.let { key to it } }.toMap()
}

private fun validateBaseUrl(url: HttpUrl, allowLocal: Boolean, allowQuery: Boolean = false) {
    require(url.username.isEmpty() && url.password.isEmpty() && url.fragment == null && (allowQuery || url.query == null)) { "URL must not contain credentials, query or fragment" }
    val local = url.host in setOf("localhost", "127.0.0.1", "::1", "10.0.2.2") || url.host.startsWith("192.168.") || url.host.startsWith("10.") || Regex("172\\.(1[6-9]|2[0-9]|3[01])\\..+").matches(url.host)
    require(url.isHttps || (allowLocal && local)) { "HTTPS is required outside explicitly enabled local development" }
}
internal suspend fun Call.awaitResponse(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (!continuation.isCancelled) continuation.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) { continuation.resume(response) { _, value, _ -> value.close() } }
    })
}
