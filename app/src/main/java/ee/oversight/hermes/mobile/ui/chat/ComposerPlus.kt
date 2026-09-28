package ee.oversight.hermes.mobile.ui.chat

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.BitmapFactory
import android.speech.RecognizerIntent
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import ee.oversight.hermes.mobile.ui.theme.CyberBg
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary
import java.io.File
import java.util.Locale

/**
 * Mic button that fires [RecognizerIntent.ACTION_RECOGNIZE_SPEECH] and
 * returns the top transcript via [onResult]. No ViewModel needed.
 *
 * Hook: place next to the ChatTab Send button —
 *   VoiceInputButton(onResult = { draft = it })
 */
@Composable
fun VoiceInputButton(
  onResult: (String) -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true
) {
  val context = LocalContext.current
  val launcher = rememberLauncherForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    if (result.resultCode == Activity.RESULT_OK) {
      val text = result.data
        ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        ?.firstOrNull()
        ?.trim()
        .orEmpty()
      if (text.isNotEmpty()) onResult(text)
    }
  }

  IconButton(
    onClick = {
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(
          RecognizerIntent.EXTRA_LANGUAGE_MODEL,
          RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
        )
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak your message")
      }
      try {
        launcher.launch(intent)
      } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "Voice input not available", Toast.LENGTH_SHORT).show()
      }
    },
    modifier = modifier,
    enabled = enabled
  ) {
    Icon(
      imageVector = Icons.Filled.Mic,
      contentDescription = "Voice input",
      tint = if (enabled) NeonCyan else TextSecondary
    )
  }
}

/**
 * Floating "jump to latest" button. Parent controls [visible] from list state.
 *
 * Hook: overlay bottom-end of the ChatTab message list —
 *   val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 3 } }
 *   JumpToBottom(visible = showJump, onClick = { scope.launch { listState.scrollToItem(0) } })
 */
@Composable
fun JumpToBottom(
  visible: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier
) {
  AnimatedVisibility(
    visible = visible,
    modifier = modifier,
    enter = fadeIn() + scaleIn(),
    exit = fadeOut() + scaleOut()
  ) {
    FloatingActionButton(
      onClick = onClick,
      containerColor = NeonViolet,
      contentColor = TextPrimary
    ) {
      Icon(
        imageVector = Icons.Filled.ArrowDownward,
        contentDescription = "Jump to latest"
      )
    }
  }
}

/**
 * Full-screen dialog with a pinch-zoomable image decoded from
 * [imageBase64] (standard Base64 PNG/JPEG) or [imageFile].
 * Pass one source; base64 wins when both are set.
 *
 * Hook: open on message-image tap —
 *   var zoom by remember { mutableStateOf(false) }
 *   if (zoom) ZoomImageDialog(imageBase64 = msg.imageB64, imageFile = null,
 *     onDismiss = { zoom = false })
 */
@Composable
fun ZoomImageDialog(
  imageBase64: String?,
  imageFile: File?,
  onDismiss: () -> Unit
) {
  val bitmap = remember(imageBase64, imageFile) {
    runCatching {
      when {
        !imageBase64.isNullOrBlank() -> {
          val bytes = Base64.decode(imageBase64, Base64.DEFAULT)
          BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
        imageFile != null && imageFile.exists() ->
          BitmapFactory.decodeFile(imageFile.absolutePath)
        else -> null
      }
    }.getOrNull()
  }

  var scale by remember { mutableFloatStateOf(1f) }
  var offset by remember { mutableStateOf(Offset.Zero) }
  val transformState = rememberTransformableState { zoom, pan, _ ->
    scale = (scale * zoom).coerceIn(1f, 6f)
    offset = if (scale <= 1f) Offset.Zero else offset + pan
  }

  Dialog(
    onDismissRequest = onDismiss,
    properties = DialogProperties(usePlatformDefaultWidth = false)
  ) {
    Box(
      modifier = Modifier
        .fillMaxSize()
        .background(CyberBg.copy(alpha = 0.96f))
    ) {
      if (bitmap != null) {
        Image(
          bitmap = bitmap.asImageBitmap(),
          contentDescription = "Zoomed image",
          modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .transformable(transformState)
            .graphicsLayer(
              scaleX = scale,
              scaleY = scale,
              translationX = offset.x,
              translationY = offset.y
            )
        )
      }
      IconButton(
        onClick = onDismiss,
        modifier = Modifier
          .align(Alignment.TopEnd)
          .padding(8.dp)
      ) {
        Icon(
          imageVector = Icons.Filled.Close,
          contentDescription = "Close",
          tint = NeonCyan
        )
      }
    }
  }
}
