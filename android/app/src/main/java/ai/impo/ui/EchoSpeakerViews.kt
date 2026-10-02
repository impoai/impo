package ai.impo.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import ai.impo.client.EchoRecord
import ai.impo.client.EchoSpeakerReview
import ai.impo.data.AppState
import ai.impo.data.AppViewModel

@Composable internal fun EchoSpeakerTranscript(vm: AppViewModel, state: AppState, record: EchoRecord) {
    var editing by remember(record.id) { mutableStateOf(false) }
    val review = record.speakerReview ?: EchoSpeakerReview()
    val saving = "speakers" in state.busy
    if (record.speakerIds.isNotEmpty() && record.speakerReview != null) {
        PaperCard(Modifier.fillMaxWidth()) {
            Text(when (review.status) {
                "confirmed" -> "Your voice is selected"
                "not_present" -> "You are not in this recording"
                else -> "Which voice is yours?"
            }, style = MaterialTheme.typography.titleMedium)
            Text(if (review.status == "confirmed") "Only your selected speech can be used in memories and Brief. You can exclude individual passages below."
                 else "This Echo is not used in memories or Brief until you confirm your voice.", color = Muted)
            Text("Speaker labels apply only to this recording. The full transcript stays in Echo.", color = Muted, style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { editing = true }, enabled = !saving, modifier = Modifier.testTag("echo.speakers.edit")) {
                Text(if (review.status == "unconfirmed") "Choose your voice" else "Change your voice")
            }
        }
    }
    ErrorNotice(state.errors["speakers"])
    if (record.utterances.isNotEmpty()) {
        record.utterances.forEach { turn ->
            val isSelf = review.status == "confirmed" && turn.speaker in review.selfSpeakerIds
            val included = review.includes(turn)
            Column(Modifier.fillMaxWidth().testTag("echo.utterance.${turn.id}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(record.speakerLabel(turn.speaker) + if (isSelf) " · You" else "", color = if (isSelf) Forest else Muted,
                        style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    if (isSelf) TextButton(onClick = {
                        val excluded = if (included) review.excludedUtteranceIds + turn.id else review.excludedUtteranceIds - turn.id
                        vm.reviewSpeakers(record, review.copy(excludedUtteranceIds = excluded))
                    }, enabled = !saving, modifier = Modifier.testTag("echo.speakers.${turn.id}.toggle")) { Text(if (included) "Exclude" else "Include") }
                }
                SelectionContainer { Text(turn.text, style = MaterialTheme.typography.bodyLarge) }
                if (isSelf && !included) Text("Excluded from memories and Brief", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
        }
    } else if (record.transcript.isNotBlank()) {
        SelectionContainer { Text(record.transcript, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("echo.transcript")) }
        Text(if (record.speakerReview == null) "Speaker labels are not available for this recording."
             else "Speaker labels are not available. This Echo is not used in memories or Brief.", color = Muted, style = MaterialTheme.typography.bodySmall)
    }
    if (editing) EchoSpeakerEditor(vm, state, record) { editing = false }
}

@Composable private fun EchoSpeakerEditor(vm: AppViewModel, state: AppState, record: EchoRecord, dismiss: () -> Unit) {
    var review by remember(record.id, record.speakerReview?.revision) { mutableStateOf(record.speakerReview ?: EchoSpeakerReview()) }
    val saving = "speakers" in state.busy
    AlertDialog(onDismissRequest = { if (!saving) dismiss() }, title = { Text("Your voice") },
        containerColor = Paper, titleContentColor = Ink, textContentColor = Ink,
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Speaker labels can be wrong. Check the passages before choosing your voice. If your voice was split into more than one speaker, select each one.")
                record.speakerIds.forEachIndexed { index, speaker ->
                    val selected = review.status == "confirmed" && speaker in review.selfSpeakerIds
                    OutlinedCard(onClick = {
                        val selectedIds = if (selected) review.selfSpeakerIds - speaker else review.selfSpeakerIds + speaker
                        review = review.copy(status = if (selectedIds.isEmpty()) "unconfirmed" else "confirmed", selfSpeakerIds = selectedIds,
                            excludedUtteranceIds = if (selectedIds.isEmpty()) emptyList() else review.excludedUtteranceIds)
                    }, enabled = !saving, modifier = Modifier.fillMaxWidth().testTag("echo.speakers.option.$index")) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(record.speakerLabel(speaker), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                Icon(if (selected) Icons.Outlined.CheckCircle else Icons.Outlined.RadioButtonUnchecked, if (selected) "This is me" else "Select speaker", tint = Forest)
                            }
                            if (selected) Text("This is me", color = Forest)
                            record.utterances.filter { it.speaker == speaker }.take(2).forEach { Text(it.text, maxLines = 4) }
                        }
                    }
                }
                listOf(Triple("Not sure", "unconfirmed", "unknown"), Triple("None of these is me", "not_present", "none")).forEach { (label, status, tag) ->
                    TextButton(onClick = { review = review.copy(status = status, selfSpeakerIds = emptyList(), excludedUtteranceIds = emptyList()) },
                        enabled = !saving, modifier = Modifier.fillMaxWidth().testTag("echo.speakers.$tag")) {
                        Icon(if (review.status == status) Icons.Outlined.CheckCircle else Icons.Outlined.RadioButtonUnchecked, null)
                        Spacer(Modifier.width(8.dp)); Text(label)
                    }
                }
                Text("Only confirmed speech is eligible for personal memories and Brief. Changing your choice withdraws memories and Briefs that relied on the previous choice. The full transcript remains in Echo.", style = MaterialTheme.typography.bodySmall)
                ErrorNotice(state.errors["speakers"])
            }
        },
        confirmButton = { TextButton(onClick = { vm.reviewSpeakers(record, review, dismiss) }, enabled = !saving, modifier = Modifier.testTag("echo.speakers.save")) { Text(if (saving) "Saving…" else "Save") } },
        dismissButton = { TextButton(onClick = dismiss, enabled = !saving) { Text("Cancel") } })
}
