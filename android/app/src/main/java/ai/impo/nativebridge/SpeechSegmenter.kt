package ai.impo.nativebridge

/** Sample-clock segmentation, with bounded silence in RAM and confirmed speech on disk. */
class SpeechSegmenter(
    private val preRoll: Int = 16000,
    private val startFrames: Int = 5,
    private val endSilence: Int = 12800,
    private val tail: Int = 8000,
    // PCM/WAV stays below the API's 1 MiB decoded audio limit, including header.
    private val maximum: Int = 16000 * 25,
) {
    sealed interface Event {
        data class Begin(val sample: Long, val audio: ShortArray) : Event
        data class Append(val audio: ShortArray) : Event
        data class End(val sample: Long) : Event
    }
    var position = 0L; private set
    var isSpeaking = false; private set
    private var recent = ShortArray(0)
    private var silence = ShortArray(0)
    private var candidates = 0
    private var start = 0L
    private var writtenEnd = 0L
    private var lastEnd = 0L

    init { require(preRoll >= 0 && startFrames > 0 && endSilence > 0 && tail in 0..endSilence && maximum > preRoll + startFrames * 512 + endSilence) }

    fun consume(samples: ShortArray, probability: Float): List<Event> {
        require(samples.isNotEmpty() && samples.size <= 512)
        require(probability.isFinite() && probability in 0f..1f)
        position += samples.size
        recent = (recent + samples).takeLastArray(preRoll + startFrames * 512)
        val events = mutableListOf<Event>()
        if (!isSpeaking) {
            candidates = if (probability >= .5f) candidates + 1 else 0
            if (candidates < startFrames) return emptyList()
            start = maxOf(lastEnd, position - recent.size)
            events.add(Event.Begin(start, recent.takeLastArray((position - start).toInt())))
            writtenEnd = position; isSpeaking = true; candidates = 0
        } else if (probability < .35f) {
            silence += samples
            if (silence.size >= endSilence) return events + finish()
        } else {
            if (silence.isNotEmpty()) { events.add(Event.Append(silence)); silence = ShortArray(0) }
            events.add(Event.Append(samples)); writtenEnd = position
        }
        // Finish before the next frame could violate the PCM byte cap. The next
        // segment starts at the previous end, with no invented time or overlap.
        if (isSpeaking && position - start >= maximum - 512) events.addAll(finish())
        return events
    }

    fun finish(): List<Event> {
        if (!isSpeaking) { candidates = 0; return emptyList() }
        val events = mutableListOf<Event>()
        val remaining = minOf(tail, silence.size, (maximum - (writtenEnd - start)).toInt().coerceAtLeast(0))
        if (remaining > 0) { events.add(Event.Append(silence.copyOfRange(0, remaining))); writtenEnd += remaining }
        events.add(Event.End(writtenEnd)); lastEnd = writtenEnd
        isSpeaking = false; candidates = 0; silence = ShortArray(0)
        return events
    }

    private fun ShortArray.takeLastArray(count: Int) = copyOfRange((size - count).coerceAtLeast(0), size)
}
