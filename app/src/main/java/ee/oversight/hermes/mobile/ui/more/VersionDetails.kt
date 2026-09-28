package ee.oversight.hermes.mobile.ui.more

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Provenance block for SetupTab: which app build talks to which backend.
 * All values passed in as params — caller reads BuildConfig / vm state.
 */
@Composable
fun VersionDetailsCard(
  appVersion: String,
  versionCode: Int,
  packageName: String,
  backendVersion: String,
  gatewayUrl: String,
  modifier: Modifier = Modifier
) {
  Card(
    modifier = modifier.fillMaxWidth(),
    colors = CardDefaults.cardColors(containerColor = CyberSurface),
    border = BorderStroke(1.dp, CyberSurfaceBorder)
  ) {
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text("Version details", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = TextSecondary)
      VersionRow("App", "$appVersion ($versionCode)")
      VersionRow("Package", packageName)
      VersionRow("Backend", backendVersion.ifBlank { "—" })
      VersionRow("Gateway", gatewayUrl.ifBlank { "—" })
    }
  }
}

@Composable
private fun VersionRow(label: String, value: String) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(label, fontSize = 12.sp, color = TextSecondary)
    Spacer(Modifier.height(0.dp))
    Text(value, fontSize = 12.sp, color = TextPrimary)
  }
}

/** Tone for the update-check row: idle (cyan), available (green), error (red/amber). */
enum class UpdateStatus { IDLE, AVAILABLE, ERROR }

@Composable
fun UpdateStatusRow(
  status: UpdateStatus,
  onCheck: () -> Unit,
  modifier: Modifier = Modifier,
  note: String = ""
) {
  val tone = when (status) {
    UpdateStatus.IDLE -> NeonCyan
    UpdateStatus.AVAILABLE -> NeonGreen
    UpdateStatus.ERROR -> NeonRed
  }
  val label = when (status) {
    UpdateStatus.IDLE -> "Up to date check"
    UpdateStatus.AVAILABLE -> "Update available"
    UpdateStatus.ERROR -> "Update check failed"
  }
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically
  ) {
    Column(Modifier.weight(1f)) {
      Text(label, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = tone)
      if (note.isNotBlank()) Text(note, fontSize = 12.sp, color = TextSecondary)
      else if (status == UpdateStatus.AVAILABLE)
        Text("A newer build is ready to install.", fontSize = 12.sp, color = TextSecondary)
      else if (status == UpdateStatus.ERROR)
        Text("Could not reach the update source.", fontSize = 12.sp, color = NeonAmber)
    }
    OutlinedButton(onClick = onCheck) { Text("Check", color = tone) }
  }
}
