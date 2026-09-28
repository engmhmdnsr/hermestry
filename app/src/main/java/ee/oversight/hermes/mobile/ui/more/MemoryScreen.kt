package ee.oversight.hermes.mobile.ui.more

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.MemoryInfo
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Memory status + flattened node list (read-only).
 *
 * NOTE: MemoryInfo carries only summary/entries (no per-node API on the
 * gateway), so the "node list" is the summary split into non-blank lines.
 * The gateway exposes no memory-reset endpoint, so this screen offers no
 * reset action — status display only.
 */
@Composable
fun MemoryScreen(
  info: MemoryInfo?,
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
        "// MEMORY", color = NeonCyan, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold
      )
      TextButton(onClick = onRefresh) { Text("Refresh", color = NeonCyan, fontSize = 12.sp) }
    }
    Card(
      colors = CardDefaults.cardColors(containerColor = CyberSurface),
      border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder),
      modifier = Modifier.fillMaxWidth()
    ) {
      Column(Modifier.padding(12.dp)) {
        if (info == null) {
          Text("Memory unavailable — gateway offline or no memory endpoint.", color = TextSecondary, fontSize = 13.sp)
        } else {
          Text(
            if (info.enabled) "ENABLED" else "DISABLED",
            color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace
          )
          if (info.provider.isNotBlank()) {
            Text("provider: ${info.provider}", color = TextSecondary, fontSize = 12.sp)
          }
          Text("entries: ${info.entries}", color = TextSecondary, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace)
          Spacer(Modifier.height(8.dp))
          val nodes = info.summary.lineSequence().map { it.trim() }.filter { it.isNotBlank() }.toList()
          Text("nodes (${nodes.size})", color = TextSecondary, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace)
          if (nodes.isEmpty()) {
            Text("No memory entries stored.", color = TextSecondary, fontSize = 13.sp)
          } else {
            nodes.take(50).forEach { n ->
              Text("• $n", color = TextPrimary, fontSize = 13.sp)
            }
            if (nodes.size > 50) {
              Text("…and ${nodes.size - 50} more", color = TextSecondary, fontSize = 12.sp)
            }
          }
          Spacer(Modifier.height(8.dp))
          Text("Reset is not supported by the gateway — read-only status.",
            color = TextSecondary, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace)
        }
      }
    }
  }
}
