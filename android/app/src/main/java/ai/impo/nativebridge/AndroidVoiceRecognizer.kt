package ai.impo.nativebridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/** Android owns recognition. Its default service may use the network when on-device recognition is absent. */
class AndroidVoiceRecognizerFactory(private val context: Context) : VoiceRecognizerFactory {
    override fun create(listener: (VoiceRecognitionEvent) -> Unit): VoiceRecognizer {
        val local = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        check(local || SpeechRecognizer.isRecognitionAvailable(context)) {
            "Speech recognition isn't installed on this device. Enable a speech service in Android settings, or type your message."
        }
        val speech = if (local && Build.VERSION.SDK_INT >= 31) SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            else SpeechRecognizer.createSpeechRecognizer(context)
        speech.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = listener(VoiceRecognitionEvent.Ready)
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = listener(VoiceRecognitionEvent.Level((rmsdB + 2) / 12))
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onError(error: Int) = listener(VoiceRecognitionEvent.Failure(when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission was removed. Allow it in Android settings."
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was recognized. Hold again or type your message."
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_AUDIO -> "The microphone is busy. Pause other recording and try again."
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition couldn't connect. Check your connection or type your message."
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "Speech recognition isn't available for your language. Check your speech service's language settings."
                else -> "Speech recognition was interrupted. Hold again or type your message."
            }))
            override fun onResults(results: Bundle?) = listener(VoiceRecognitionEvent.Final(text(results)))
            override fun onPartialResults(partialResults: Bundle?) = listener(VoiceRecognitionEvent.Partial(text(partialResults)))
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
            private fun text(bundle: Bundle?) = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
        })
        return object : VoiceRecognizer {
            override val onDevice = local
            override fun start() {
                speech.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 60_000L)
                })
            }
            override fun finish() = speech.stopListening()
            override fun close() { runCatching { speech.cancel() }; speech.destroy() }
        }
    }
}
