package ee.oversight.hermes.mobile.ui.more

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.SkillInfo
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Skills list with enable toggle + expandable detail.
 * Pure params composable — caller (MoreTab) wires vm.skills / vm.toggleSkill.
 */
@Composable
fun SkillsScreen(
  skills: List<SkillInfo>,
  onToggle: (id: String, on: Boolean) -> Unit,
  onRefresh: () -> Unit,
  modifier: Modifier = Modifier
) {
  Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically
    ) {
      Text(
        "// SKILLS (${skills.size})", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold
      )
      TextButton(onClick = onRefresh) { Text("Refresh", color = NeonCyan, fontSize = 12.sp) }
    }
    if (skills.isEmpty()) {
      Text(
        "No skills found. The gateway may be offline or expose none.",
        color = TextSecondary, fontSize = 13.sp
      )
    }
    skills.forEach { s ->
      var open by remember(s.id) { mutableStateOf(false) }
      Card(
        colors = CardDefaults.cardColors(containerColor = CyberSurface),
        border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder),
        modifier = Modifier.fillMaxWidth().clickable { open = !open }
      ) {
        Column(Modifier.padding(12.dp)) {
          Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
          ) {
            Text(
              s.name.ifBlank { s.id }, color = TextPrimary, fontSize = 14.sp,
              fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f)
            )
            Switch(
              checked = s.enabled,
              onCheckedChange = { onToggle(s.id, it) },
              colors = SwitchDefaults.colors(checkedTrackColor = NeonViolet)
            )
          }
          Text(
            if (s.enabled) "enabled" else "disabled",
            color = TextSecondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace
          )
          if (open) {
            Spacer(Modifier.height(4.dp))
            Text(
              "id: ${s.id}", color = TextSecondary, fontSize = 11.sp,
              fontFamily = FontFamily.Monospace
            )
            if (s.description.isNotBlank()) {
              Spacer(Modifier.height(2.dp))
              Text(s.description, color = TextPrimary, fontSize = 13.sp)
            } else {
              Text("No description.", color = TextSecondary, fontSize = 13.sp)
            }
          }
        }
      }
    }
  }
}
