package ee.oversight.hermes.mobile.ui.more

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.GatewayStatus
import ee.oversight.hermes.mobile.ui.chat.ChatFontScale
import ee.oversight.hermes.mobile.ui.chat.ChatFontSizeRow
import ee.oversight.hermes.mobile.ui.chat.ReasoningEffort
import ee.oversight.hermes.mobile.ui.chat.ReasoningEffortRow
import ee.oversight.hermes.mobile.ui.chat.saveChatFontScale
import ee.oversight.hermes.mobile.model.PendingApproval
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * About block: ONE compact card with two-column rows. Backend version/state
 * rows are hidden entirely while blank (no '-' placeholders).
 */
@Composable
fun AboutScreen(
  appVersion: String,
  packageName: String,
  gatewayUrl: String,
  backend: GatewayStatus?,
  modifier: Modifier = Modifier
) {
  Column(
    modifier = modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(6.dp)
  ) {
    Text("// ABOUT", fontSize = 12.sp, color = NeonCyan,
      fontFamily = FontFamily.Monospace)
    Card(
      modifier = Modifier.fillMaxWidth(),
      colors = CardDefaults.cardColors(containerColor = CyberSurface),
      border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder)
    ) {
      Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        AboutTableRow("App version", appVersion)
        AboutTableRow("Package", packageName)
        AboutTableRow("Gateway URL", gatewayUrl.ifBlank { "—" })
        if (!backend?.version.isNullOrBlank()) {
          AboutTableRow("Backend version", backend?.version.orEmpty())
        }
        if (!backend?.gatewayState.isNullOrBlank()) {
          AboutTableRow("Backend state", backend?.gatewayState.orEmpty())
        }
        if (!backend?.detail.isNullOrBlank()) {
          AboutTableRow("Detail", backend?.detail.orEmpty())
        }
      }
    }
  }
}

@Composable
private fun AboutTableRow(label: String, value: String) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(label, fontSize = 12.sp, color = TextSecondary,
      modifier = Modifier.weight(1f))
    Text(value, fontSize = 12.sp, color = TextPrimary,
      fontFamily = FontFamily.Monospace)
  }
}

/**
 * Read-only notification center built from pending approvals + status lines.
 * No actions — approving happens where the approvals UI lives.
 */
@Composable
fun NotifCenter(
  approvals: List<PendingApproval>,
  statusLines: List<String>,
  modifier: Modifier = Modifier
) {
  Column(
    modifier = modifier.fillMaxWidth().padding(vertical = 8.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp)
  ) {
    Text(
      "Notifications",
      fontSize = 20.sp,
      fontWeight = FontWeight.Bold,
      color = TextPrimary,
      modifier = Modifier.padding(bottom = 4.dp)
    )
    for (a in approvals) {
      Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = CyberSurface),
        border = androidx.compose.foundation.BorderStroke(1.dp, NeonAmber.copy(alpha = 0.4f))
      ) {
        Column(Modifier.padding(12.dp)) {
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Approval pending", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = NeonAmber)
            Text(a.sessionId.take(8), fontSize = 12.sp, color = TextSecondary)
          }
          Spacer(Modifier.height(4.dp))
          Text(a.summary, fontSize = 14.sp, color = TextPrimary)
        }
      }
    }
    for (line in statusLines) {
      Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = CyberSurface),
        border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder)
      ) {
        Row(Modifier.padding(12.dp)) {
          Text(
            "● ",
            color = if (line.contains("error", ignoreCase = true) ||
              line.contains("fail", ignoreCase = true)
            ) NeonRed else NeonCyan
          )
          Text(line, fontSize = 14.sp, color = TextPrimary)
        }
      }
    }
    if (approvals.isEmpty() && statusLines.isEmpty()) {
      Text("No notifications.", color = TextSecondary)
    }
  }
}
