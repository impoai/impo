package ai.impo.ui

import ai.impo.client.DeliveredFile
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.text.format.Formatter
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File

/**
 * Files an assistant reply delivered. Tapping one downloads it into the account's file
 * cache once, then opens it in a viewer app (or a share sheet when none is installed).
 */
@Composable internal fun DeliveredFiles(files: List<DeliveredFile>, download: suspend (DeliveredFile) -> File) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        files.forEach { file ->
            val size = Formatter.formatShortFileSize(context, file.sizeBytes)
            OutlinedCard(onClick = {
                loading = file.fileId; error = null
                scope.launch {
                    try { openDelivered(context, file, download(file)) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { error = "Couldn't open ${file.name}. Check your connection and try again." }
                    finally { loading = null }
                }
            }, enabled = loading == null, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Border),
                colors = CardDefaults.outlinedCardColors(containerColor = RaisedPaper, disabledContainerColor = RaisedPaper),
                modifier = Modifier.widthIn(max = 360.dp).fillMaxWidth().heightIn(min = 60.dp).testTag("message.file")
                    .semantics { contentDescription = "${file.name}, $size. Opens the file" }) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Surface(shape = RoundedCornerShape(10.dp), color = Apricot.copy(alpha = .14f), modifier = Modifier.size(40.dp)) {
                        Box(contentAlignment = Alignment.Center) { Icon(fileIcon(file), null, tint = Apricot) }
                    }
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        Text(file.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = Ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(size, style = MaterialTheme.typography.bodySmall, color = Muted)
                    }
                    if (loading == file.fileId) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Outlined.FileDownload, null, tint = Muted)
                }
            }
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Muted) }
    }
}

private fun openDelivered(context: Context, file: DeliveredFile, stored: File) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", stored)
    val type = file.mediaType.ifBlank { "application/octet-stream" }
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try { context.startActivity(view) }
    catch (_: ActivityNotFoundException) {
        val share = Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(share, file.name))
    }
}

private fun fileIcon(file: DeliveredFile): ImageVector = when {
    file.mediaType == "application/pdf" -> Icons.Outlined.PictureAsPdf
    file.mediaType.startsWith("image/") -> Icons.Outlined.Image
    file.mediaType.startsWith("audio/") -> Icons.Outlined.AudioFile
    file.mediaType.startsWith("video/") -> Icons.Outlined.VideoFile
    file.mediaType.contains("spreadsheet") || file.mediaType == "text/csv" -> Icons.Outlined.TableChart
    file.mediaType == "application/zip" -> Icons.Outlined.FolderZip
    else -> Icons.Outlined.Description
}
