package ee.oversight.hermes.mobile.ui.components

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.TextSecondary
import java.util.Locale

/**
 * Small speaker button next to an assistant reply: reads the text aloud
 * using the device's built-in TextToSpeech engine (offline, no API key).
 * Ported from Hermes Control: shared app-wide engine singleton.
 */
@Composable
fun TtsSpeaker(
  text: String,
  modifier: Modifier = Modifier
) {
  val context = LocalContext.current
  var speaking by remember { mutableStateOf(false) }
  var ready by remember { mutableStateOf(false) }

  DisposableEffect(Unit) {
    SharedTts.ensure(context)
    val check = object : android.os.CountDownTimer(3000, 100) {
      override fun onTick(millisUntilFinished: Long) {
        if (SharedTts.isReady()) {
          ready = true
          cancel()
        }
      }
      override fun onFinish() {
        ready = SharedTts.isReady()
      }
    }
    check.start()
    onDispose { check.cancel() }
  }

  fun speak() {
    val engine = SharedTts.engine ?: return
    engine.language = Locale.getDefault()
    val utteranceId = "hermes_tts_${System.currentTimeMillis()}"
    engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {}
      override fun onDone(utteranceId: String?) {
        speaking = false
      }
      override fun onError(utteranceId: String?) {
        speaking = false
      }
      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?, errorCode: Int) {
        speaking = false
      }
    })
    speaking = true
    engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
  }

  Box(
    modifier = modifier
      .size(24.dp)
      .clip(CircleShape)
      .background(if (speaking) NeonCyan.copy(alpha = 0.2f) else Color(0xFF141A26))
      .border(1.dp, if (speaking) NeonCyan else Color(0xFF2A3448), CircleShape)
      .clickable(enabled = text.isNotBlank() && ready) {
        if (speaking) {
          SharedTts.engine?.stop()
          speaking = false
        } else {
          speak()
        }
      },
    contentAlignment = Alignment.Center
  ) {
    Icon(
      imageVector = Icons.Default.VolumeUp,
      contentDescription = "Speak reply",
      tint = if (speaking) NeonCyan else if (ready) TextSecondary else TextSecondary.copy(alpha = 0.4f),
      modifier = Modifier.size(14.dp)
    )
  }
}

/** App-wide singleton TextToSpeech engine (one per app, OS reclaims on death). */
private object SharedTts {
  @Volatile
  var engine: TextToSpeech? = null
    private set

  @Volatile
  private var readyFlag = false

  fun isReady(): Boolean = readyFlag

  fun ensure(context: Context) {
    if (engine != null) return
    synchronized(this) {
      if (engine != null) return
      engine = TextToSpeech(context.applicationContext) { status ->
        readyFlag = status == TextToSpeech.SUCCESS
      }
    }
  }
}
