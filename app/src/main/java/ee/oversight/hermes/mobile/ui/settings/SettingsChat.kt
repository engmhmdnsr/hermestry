package ee.oversight.hermes.mobile.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.MobileViewModel
import ee.oversight.hermes.mobile.ui.chat.AutoApprovePill
import ee.oversight.hermes.mobile.ui.chat.AutoApproveState
import ee.oversight.hermes.mobile.ui.chat.ChatFontScale
import ee.oversight.hermes.mobile.ui.chat.ChatFontSizeRow
import ee.oversight.hermes.mobile.ui.chat.ReasoningEffort
import ee.oversight.hermes.mobile.ui.chat.ReasoningEffortRow
import ee.oversight.hermes.mobile.ui.chat.saveChatFontScale
import ee.oversight.hermes.mobile.ui.more.NotifCenter
import ee.oversight.hermes.mobile.ui.security.AppLockPrefs
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Chat settings section: font size, reasoning effort, auto-approve,
 * app lock, notifications, TTS note. Dark terminal styling.
 */
@Composable
fun ChatSection(vm: MobileViewModel, modifier: Modifier = Modifier) {
  val ctx = LocalContext.current
  val approvals by vm.approvals.collectAsState()
  val status by vm.status.collectAsState()
  val install by vm.install.collectAsState()
  var autoAll by remember { mutableStateOf(AutoApproveState.global) }
  var lockOn by remember { mutableStateOf(AppLockPrefs.isEnabled(ctx)) }

  Column(
    modifier = modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(6.dp)
  ) {
    Card(
      modifier = Modifier.fillMaxWidth(),
      colors = CardDefaults.cardColors(containerColor = CyberSurface),
      border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder)
    ) {
      Column(
        Modifier.padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
      ) {
        ChatFontSizeRow(
          onScaleChange = {
            ChatFontScale.value = it
            saveChatFontScale(ctx, it)
          }
        )
        ReasoningEffortRow(
          onEffortSelected = { ReasoningEffort.save(ctx, it) }
        )
        Row(
          horizontalArrangement = Arrangement.spacedBy(12.dp),
          verticalAlignment = Alignment.CenterVertically
        ) {
          AutoApprovePill(
            globalAutoApprove = autoAll,
            onToggleGlobal = {
              autoAll = it
              AutoApproveState.global = it
              AutoApproveState.saveGlobal(ctx, it)
            }
          )
          // Copied from SetupTab GATEWAY block (MainActivity): tiny lock toggle row.
          Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.clickable {
              lockOn = !lockOn
              AppLockPrefs.setEnabled(ctx, lockOn)
            }
          ) {
            Text(
              if (lockOn) "🔒 lock on" else "🔓 lock off",
              color = if (lockOn) NeonAmber else TextSecondary,
              fontSize = 12.sp,
              fontFamily = FontFamily.Monospace
            )
          }
        }
        // TtsSpeaker exposes no user setting (stateless per-message speak
        // button over a private SharedTts singleton), so no toggle here.
        Text(
          "TTS: per-reply speaker button, device engine, no setting.",
          fontSize = 11.sp,
          color = TextSecondary,
          fontFamily = FontFamily.Monospace
        )
      }
    }
    NotifCenter(
      approvals = approvals,
      statusLines = listOf(
        "gateway install: $install",
        if (status.version.isNotBlank()) "backend v${status.version}" else "backend version unknown",
        if (status.gatewayState.isNotBlank()) "state ${status.gatewayState}" else "state unknown"
      )
    )
  }
}
