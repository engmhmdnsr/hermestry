package ee.oversight.hermes.mobile.ui.settings

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.InstallState
import ee.oversight.hermes.mobile.MobileViewModel
import ee.oversight.hermes.mobile.ui.system.BackupCard
import ee.oversight.hermes.mobile.ui.system.DebugShareCard
import ee.oversight.hermes.mobile.ui.system.DoctorCard
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Settings → gateway section. Extracted from SetupTab (MainActivity.kt):
 * gateway Start/Stop controls + LIVE/DOWN state + autostart toggle
 * (single source, immediate-save) and the OPS cards (reused by import).
 * Auto-approve + app lock live only in ChatSection — deliberately excluded.
 * Keys, tips and version card live elsewhere — deliberately excluded.
 */
@Composable
fun GatewaySection(vm: MobileViewModel) {
  val install by vm.install.collectAsState()
  val connected by vm.connected.collectAsState()
  val ctx = LocalContext.current
  // Single autostart source: immediate-save, keyed so external edits refresh.
  val persistedAuto = vm.autostart()
  var auto by remember(persistedAuto) { mutableStateOf(persistedAuto) }

  Card(
    colors = CardDefaults.cardColors(containerColor = CyberSurface),
    modifier = Modifier.fillMaxWidth()
  ) {
    Column(Modifier.padding(12.dp)) {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
          onClick = {
            try {
              vm.start()
              Toast.makeText(ctx, "starting gateway…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
              Toast.makeText(ctx, "start failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
          },
          enabled = install == InstallState.INSTALLED || install == InstallState.FAILED,
          colors = ButtonDefaults.buttonColors(containerColor = NeonGreen,
            contentColor = Color.Black)
        ) {
          Icon(Icons.Filled.PlayArrow, null)
          Text("Start")
        }
        OutlinedButton(onClick = {
          try {
            vm.stop()
            Toast.makeText(ctx, "gateway stopped", Toast.LENGTH_SHORT).show()
          } catch (e: Exception) {
            Toast.makeText(ctx, "stop failed: ${e.message}", Toast.LENGTH_LONG).show()
          }
        }) { Text("Stop") }
      }
      Spacer(Modifier.height(6.dp))
      Text(if (connected) "GATEWAY LIVE" else "GATEWAY DOWN",
        color = if (connected) NeonGreen else NeonRed,
        fontFamily = FontFamily.Monospace, fontSize = 14.sp,
        fontWeight = FontWeight.Bold)
      Text("state: $install", color = TextSecondary,
        fontSize = 12.sp, fontFamily = FontFamily.Monospace)
      Spacer(Modifier.height(6.dp))
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Auto-start on boot", color = TextPrimary, fontSize = 14.sp)
        Spacer(Modifier.width(8.dp))
        Switch(
          auto,
          {
            auto = it
            try {
              vm.saveKeys(vm.provider(), vm.apiKey(), vm.modelId(), vm.baseUrl(),
                vm.tgToken(), vm.discordToken(), vm.serverKey(), it)
              SettingsPrefsTick.bump()
              Toast.makeText(ctx,
                if (it) "auto-start on" else "auto-start off",
                Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
              Toast.makeText(ctx, "auto-start save failed: ${e.message}",
                Toast.LENGTH_LONG).show()
            }
          },
          colors = SwitchDefaults.colors(checkedTrackColor = NeonViolet))
      }
    }
  }

  Text("// OPS", color = NeonCyan, fontSize = 12.sp,
    fontFamily = FontFamily.Monospace)
  // OPS cards always talk to the ON-PHONE gateway at 127.0.0.1:8080.
  // Never use vm.baseUrl() here: that is the LLM PROVIDER base URL (custom
  // provider endpoint), and feeding it to GatewayClient would send the local
  // server key as a Bearer token to a third-party host. The server key is
  // still re-read after every ConnSection Save (SettingsPrefsTick) so the
  // cards never use a stale key.
  val prefsTick = SettingsPrefsTick.tick
  val baseUrl = remember(prefsTick) { "http://127.0.0.1:8080" }
  val apiKey = remember(prefsTick) { vm.serverKey() }
  DoctorCard(baseUrl, apiKey)
  BackupCard(baseUrl, apiKey)
  DebugShareCard(baseUrl, apiKey)
}
