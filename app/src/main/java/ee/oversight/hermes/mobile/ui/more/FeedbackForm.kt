package ee.oversight.hermes.mobile.ui.more

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceElevated
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URLEncoder

private const val FEEDBACK_URL = "https://formsubmit.co/ajax/mhmdnsr@oversight.ee"

/**
 * Feedback card ported from Control's GatewayConfigScreen feedback section:
 * name + message fields, delivered to the developer inbox via FormSubmit
 * (no API key in the app). FormSubmit needs a one-time activation: the owner
 * confirms the first submission once, later ones deliver automatically.
 */
@Composable
fun FeedbackForm(modifier: Modifier = Modifier) {
  var name by remember { mutableStateOf("") }
  var message by remember { mutableStateOf("") }
  var sending by remember { mutableStateOf(false) }
  var sent by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  Column(modifier = modifier.fillMaxWidth()) {
    Text(
      "FEEDBACK",
      fontSize = 12.sp,
      color = NeonCyan,
      fontFamily = FontFamily.Monospace
    )
    Spacer(Modifier.height(4.dp))
    Text(
      "Send a note to the developer. Your name helps us reply.",
      fontSize = 10.sp,
      color = TextSecondary,
      fontFamily = FontFamily.Monospace
    )
    Spacer(Modifier.height(10.dp))
    OutlinedTextField(
      value = name,
      onValueChange = { name = it; sent = false; error = null },
      label = { Text("Your name", fontSize = 11.sp, fontFamily = FontFamily.Monospace) },
      placeholder = { Text("Ada", fontSize = 10.sp, color = TextSecondary, fontFamily = FontFamily.Monospace) },
      singleLine = true,
      textStyle = androidx.compose.ui.text.TextStyle(color = TextPrimary, fontSize = 12.sp, fontFamily = FontFamily.Monospace),
      colors = feedbackFieldColors(),
      modifier = Modifier.fillMaxWidth()
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
      value = message,
      onValueChange = { message = it; sent = false; error = null },
      label = { Text("Your message / suggestion", fontSize = 11.sp, fontFamily = FontFamily.Monospace) },
      placeholder = { Text("Write your feedback here...", fontSize = 10.sp, color = TextSecondary, fontFamily = FontFamily.Monospace) },
      minLines = 3,
      maxLines = 6,
      textStyle = androidx.compose.ui.text.TextStyle(color = TextPrimary, fontSize = 12.sp, fontFamily = FontFamily.Monospace),
      colors = feedbackFieldColors(),
      modifier = Modifier.fillMaxWidth()
    )
    Spacer(Modifier.height(10.dp))
    Button(
      onClick = {
        error = null
        if (message.isBlank()) {
          error = "Please write a message first."
          return@Button
        }
        sending = true
        scope.launch {
          val ok = sendFeedback(name.trim(), message.trim())
          sending = false
          if (ok) {
            sent = true
            message = ""
          } else {
            error = "Send failed — check connection and try again."
          }
        }
      },
      enabled = !sending,
      modifier = Modifier.fillMaxWidth()
    ) {
      if (sending) {
        CircularProgressIndicator(
          modifier = Modifier.then(Modifier),
          color = NeonCyan,
          strokeWidth = 2.dp
        )
      } else {
        Icon(Icons.Default.Send, contentDescription = null)
      }
      Spacer(Modifier.width(8.dp))
      Text(
        if (sent) "Sent — thank you!" else "Send feedback",
        fontSize = 12.sp,
        fontFamily = FontFamily.Monospace
      )
    }
    if (sent) {
      Spacer(Modifier.height(6.dp))
      Text(
        "Delivered. Thanks for helping improve Hermes!",
        fontSize = 11.sp,
        color = NeonGreen,
        fontFamily = FontFamily.Monospace
      )
    }
    if (error != null) {
      Spacer(Modifier.height(6.dp))
      Text(
        error!!,
        fontSize = 11.sp,
        color = NeonRed,
        fontFamily = FontFamily.Monospace
      )
    }
  }
}

@Composable
private fun feedbackFieldColors() = OutlinedTextFieldDefaults.colors(
  focusedBorderColor = NeonCyan,
  unfocusedBorderColor = CyberSurfaceBorder,
  focusedContainerColor = CyberSurfaceElevated,
  unfocusedContainerColor = CyberSurfaceElevated,
  focusedLabelColor = NeonCyan,
  unfocusedLabelColor = TextSecondary,
  cursorColor = NeonCyan
)

/** POST name/message to FormSubmit AJAX endpoint; true on 2xx. */
suspend fun sendFeedback(name: String, message: String): Boolean = withContext(Dispatchers.IO) {
  try {
    val url = java.net.URL(FEEDBACK_URL)
    val conn = url.openConnection() as java.net.HttpURLConnection
    conn.requestMethod = "POST"
    conn.doOutput = true
    conn.connectTimeout = 15000
    conn.readTimeout = 15000
    conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
    conn.setRequestProperty("Accept", "application/json")
    val body = buildString {
      append("message=").append(URLEncoder.encode(message, "UTF-8"))
      append("&_subject=").append(URLEncoder.encode("[Hermes Mobile] Feedback from ${name.ifBlank { "anonymous" }}", "UTF-8"))
      if (name.isNotBlank()) append("&name=").append(URLEncoder.encode(name, "UTF-8"))
    }
    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    conn.responseCode in 200..299
  } catch (_: Exception) {
    false
  }
}
