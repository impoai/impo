package ai.impo.ui

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import ai.impo.client.UploadedAttachment
import ai.impo.client.attachmentFormats
import ai.impo.data.AppViewModel
import kotlinx.coroutines.*
import java.util.UUID

private data class FileDraft(val id: String, val name: String, val type: String, val bytes: ByteArray, val failed: Boolean = false)

@Composable fun AttachmentPicker(vm: AppViewModel, files: List<UploadedAttachment>, changed: (List<UploadedAttachment>) -> Unit,
    blocked: (Boolean) -> Unit, sessionKey: Any?, enabled: Boolean, isCurrent: () -> Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var drafts by remember(sessionKey) { mutableStateOf(emptyList<FileDraft>()) }
    var notice by remember(sessionKey) { mutableStateOf<String?>(null) }
    var pickerOwner by remember { mutableStateOf<String?>(null) }
    var reading by remember(sessionKey) { mutableStateOf(false) }
    val jobs = remember(sessionKey) { mutableMapOf<String, Job>() }
    val latestFiles by rememberUpdatedState(files)
    val latestCurrent by rememberUpdatedState(isCurrent)
    val owner = vm.state.value.account?.requestScope
    fun upload(draft: FileDraft) {
        if (owner == null || !latestCurrent()) return
        drafts = drafts.map { if (it.id == draft.id) it.copy(failed = false) else it }; blocked(true)
        jobs[draft.id] = scope.launch {
            try {
                val file = vm.uploadAttachment(draft.id, draft.name, draft.type, draft.bytes, owner)
                if (!latestCurrent() || drafts.none { it.id == draft.id }) return@launch
                changed(latestFiles + file); drafts = drafts.filterNot { it.id == draft.id }; notice = null
            } catch (cancelled: CancellationException) { throw cancelled }
              catch (error: Exception) {
                if (latestCurrent()) { drafts = drafts.map { if (it.id == draft.id) it.copy(failed = true) else it }; notice = "Upload didn't finish. Retry or remove the file before sending." }
            } finally { jobs.remove(draft.id); if (latestCurrent()) blocked(reading || drafts.isNotEmpty()) }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val selectedOwner = pickerOwner
        if (selectedOwner != null && vm.state.value.account?.requestScope == selectedOwner && latestCurrent()) scope.launch {
            reading = true; blocked(true)
            try {
            for (uri in uris) {
                if (vm.state.value.account?.requestScope != selectedOwner || !latestCurrent()) break
                if (latestFiles.size + drafts.size >= 8) { notice = "Attach up to eight files per message."; break }
                try {
                    val draft = withContext(Dispatchers.IO) {
                        var name = "file"
                        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                            if (cursor.moveToFirst()) {
                                name = cursor.getString(0)
                                if (!cursor.isNull(1) && cursor.getLong(1) > 10 * 1024 * 1024) throw IllegalArgumentException("Choose a file up to 10 MB.")
                            }
                        }
                        val type = attachmentFormats[name.substringAfterLast('.', "").lowercase()]
                            ?: throw IllegalArgumentException("Choose PDF, Word, text, CSV, JSON, JPEG, PNG, GIF or WebP.")
                        val bytes = context.contentResolver.openInputStream(uri)?.use { stream ->
                            val output = java.io.ByteArrayOutputStream()
                            val chunk = ByteArray(8192)
                            while (output.size() <= 10 * 1024 * 1024) { val count = stream.read(chunk); if (count < 0) break; output.write(chunk, 0, count) }
                            output.toByteArray() }
                            ?: throw IllegalArgumentException("Couldn't open this file.")
                        require(bytes.isNotEmpty() && bytes.size <= 10 * 1024 * 1024) { "Choose a file up to 10 MB." }
                        FileDraft(UUID.randomUUID().toString(), name, type, bytes)
                    }
                    if (vm.state.value.account?.requestScope != selectedOwner || !latestCurrent()) break
                    drafts = drafts + draft; upload(draft)
                } catch (cancelled: CancellationException) { throw cancelled }
                  catch (error: Exception) { if (latestCurrent()) notice = (error as? IllegalArgumentException)?.message ?: "Couldn't open that file. Try choosing it again." }
            }
            } finally { if (vm.state.value.account?.requestScope == selectedOwner && latestCurrent()) { reading = false; blocked(drafts.isNotEmpty()) } }
        }
    }
    DisposableEffect(sessionKey) { onDispose { jobs.values.toList().forEach { it.cancel() } } }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { pickerOwner = owner; picker.launch(attachmentFormats.values.distinct().toTypedArray()) }, enabled = enabled && !reading && files.size + drafts.size < 8,
                modifier = Modifier.testTag("attachments.add")) { Icon(Icons.Outlined.AttachFile, null); Text("Attach") }
            files.forEach { file -> InputChip(selected = false, onClick = {}, label = { Text(file.name, maxLines = 1, modifier = Modifier.widthIn(max = 150.dp)) },
                trailingIcon = { IconButton(onClick = { changed(latestFiles.filterNot { it.id == file.id }) }, enabled = enabled) { Icon(Icons.Outlined.Close, "Remove ${file.name}") } }) }
            drafts.forEach { draft -> Row(verticalAlignment = Alignment.CenterVertically) {
                if (!draft.failed) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Text(draft.name, maxLines = 1, modifier = Modifier.widthIn(max = 120.dp))
                if (draft.failed) TextButton(onClick = { upload(draft) }) { Text("Retry") }
                IconButton(onClick = { jobs.remove(draft.id)?.cancel(); drafts = drafts.filterNot { it.id == draft.id }; blocked(reading || drafts.isNotEmpty()) }) { Icon(Icons.Outlined.Close, "Remove ${draft.name}") }
            } }
        }
        notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Muted) }
    }
}
