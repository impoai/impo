package ai.impo.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.impo.R

val Paper = Color(0xFFF4EEE3)
val RaisedPaper = Color(0xFFFCF8EE)
val Forest = Color(0xFF264D3D)
val Ink = Color(0xFF293D2E)
val Muted = Color(0xFF6E6E59)
val Border = Color(0xFFD4C7AB)
val Sage = Color(0xFFC4D4B8)
val Apricot = Color(0xFFE0914D)
@Composable fun ImpoTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = lightColorScheme(primary = Forest, onPrimary = RaisedPaper, secondary = Apricot,
        background = Paper, onBackground = Ink, surface = RaisedPaper, onSurface = Ink,
        surfaceVariant = Sage.copy(alpha = .35f), onSurfaceVariant = Muted, outline = Border),
        typography = Typography(
            headlineLarge = Typography().headlineLarge.copy(fontFamily = FontFamily.Serif, fontSize = 36.sp, color = Ink),
            headlineMedium = Typography().headlineMedium.copy(fontFamily = FontFamily.Serif, fontSize = 29.sp, color = Ink),
            titleLarge = Typography().titleLarge.copy(fontFamily = FontFamily.Serif, fontSize = 23.sp),
            bodyLarge = Typography().bodyLarge.copy(lineHeight = 25.sp),
        ), shapes = Shapes(medium = RoundedCornerShape(20.dp), large = RoundedCornerShape(28.dp)), content = content)
}
// Stable API indices match iOS; picker order remains mark first.
val avatarResources = listOf(R.drawable.avatarfox, R.drawable.avatarrobin, R.drawable.avatarcat, R.drawable.instantmark, R.drawable.avatarowl, R.drawable.avatarotter)
val avatarChoices = listOf(3, 0, 1, 2, 4, 5)
val avatarNames = listOf("Fox", "Robin", "Cat", "Impo", "Owl", "Otter")
@Composable fun AssistantAvatar(index: Int, size: Int = 42) {
    Image(painterResource(avatarResources.getOrElse(index) { avatarResources[3] }), "Assistant avatar",
        Modifier.size(size.dp).clip(CircleShape).background(RaisedPaper).padding(3.dp))
}
@Composable fun PageHeader(title: String, subtitle: String? = null, back: (() -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (back != null) IconButton(onClick = back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") }
            Text(title, style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            actions()
        }
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Muted, modifier = Modifier.padding(top = 5.dp))
    }
}
@Composable fun PaperCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier, shape = RoundedCornerShape(22.dp), color = RaisedPaper,
        border = androidx.compose.foundation.BorderStroke(.7.dp, Border.copy(alpha = .65f))) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}
@Composable fun SectionLabel(text: String) { Text(text.uppercase(), fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Muted, letterSpacing = 1.5.sp, modifier = Modifier.padding(vertical = 6.dp)) }
@Composable fun EmptyState(title: String, detail: String, action: String? = null, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AssistantAvatar(3, 62)
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(detail, color = Muted, style = MaterialTheme.typography.bodyMedium)
        if (action != null) OutlinedButton(onClick = onAction) { Text(action) }
    }
}
@Composable fun ErrorNotice(message: String?, retry: (() -> Unit)? = null) {
    if (message != null) Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            if (retry != null) IconButton(onClick = retry) { Icon(Icons.Outlined.Refresh, "Retry") }
        }
    }
}
@Composable fun BusyLine(busy: Boolean) { if (busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = Forest, trackColor = Sage) }
fun humanStatus(status: String) = status.replace('_', ' ').replaceFirstChar(Char::uppercase)
fun shortDate(value: String): String = runCatching {
    java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MMM d · HH:mm"))
}.getOrDefault(value)
