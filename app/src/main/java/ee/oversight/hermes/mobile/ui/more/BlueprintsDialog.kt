package ee.oversight.hermes.mobile.ui.more

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.Blueprint
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Entry card shown in MoreTab — opens the blueprints dialog.
 */
@Composable
fun BlueprintLaunchCard(count: Int, onOpen: () -> Unit, modifier: Modifier = Modifier) {
  Card(
    colors = CardDefaults.cardColors(containerColor = CyberSurface),
    border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder),
    modifier = modifier.fillMaxWidth().clickable(onClick = onOpen)
  ) {
    Row(
      Modifier.padding(12.dp).fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically
    ) {
      Column(Modifier.weight(1f)) {
        Text("Blueprints", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        Text(
          if (count == 0) "No blueprints loaded — tap to refresh"
          else "$count blueprint${if (count == 1) "" else "s"} — tap to instantiate",
          color = TextSecondary, fontSize = 12.sp
        )
      }
      TextButton(onClick = onOpen) { Text("Open", color = NeonCyan, fontSize = 13.sp) }
    }
  }
}

/**
 * Dialog listing blueprints with slot fill + instantiate.
 * Blueprint DTO carries no slot schema, so slots are free-form key=value
 * lines parsed into a map.
 */
@Composable
fun BlueprintsDialog(
  blueprints: List<Blueprint>,
  onInstantiate: (id: String, slots: Map<String, String>) -> Unit,
  onDismiss: () -> Unit,
  onRefresh: () -> Unit
) {
  var selected by remember { mutableStateOf<Blueprint?>(null) }
  var slotsText by remember(selected?.id) { mutableStateOf("") }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("Blueprints (${blueprints.size})") },
    text = {
      Column(
        modifier = Modifier.verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (blueprints.isEmpty()) {
          Text("No blueprints found. The gateway may be offline or expose none.", color = TextSecondary, fontSize = 13.sp)
        }
        blueprints.take(20).forEach { b ->
          val sel = selected?.id == b.id
          Card(
            colors = CardDefaults.cardColors(
              containerColor = if (sel) Color(0xFF2E1065) else CyberSurface
            ),
            border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder),
            modifier = Modifier.fillMaxWidth().clickable { selected = b }
          ) {
            Column(Modifier.padding(10.dp)) {
              Text(b.name.ifBlank { b.id }, color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
              if (b.description.isNotBlank()) {
                Text(b.description, color = TextSecondary, fontSize = 12.sp)
              }
            }
          }
        }
        if (blueprints.size > 20) {
          Text(
            "and ${blueprints.size - 20} more (showing first 20 of ${blueprints.size})",
            color = TextSecondary, fontSize = 12.sp
          )
        }
        selected?.let { b ->
          Spacer(Modifier.height(4.dp))
          Text("Slots for “${b.name.ifBlank { b.id }}” (key=value, one per line):", color = TextSecondary, fontSize = 12.sp)
          OutlinedTextField(
            value = slotsText,
            onValueChange = { slotsText = it },
            placeholder = { Text("e.g. topic=daily standup") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
            maxLines = 6
          )
        }
      }
    },
    confirmButton = {
      val b = selected
      TextButton(
        onClick = {
          if (b != null) {
            onInstantiate(b.id, parseSlots(slotsText))
            onDismiss()
          }
        },
        enabled = b != null
      ) { Text("Instantiate", color = NeonCyan) }
    },
    dismissButton = {
      Row {
        TextButton(onClick = onRefresh) { Text("Refresh") }
        TextButton(onClick = onDismiss) { Text("Close") }
      }
    }
  )
}

/** Parses key=value lines; bare lines without '=' are skipped. */
fun parseSlots(text: String): Map<String, String> {
  val out = LinkedHashMap<String, String>()
  text.lineSequence().forEach { line ->
    val t = line.trim()
    if (t.isEmpty() || t.startsWith("#")) return@forEach
    val eq = t.indexOf('=')
    if (eq <= 0) return@forEach
    out[t.substring(0, eq).trim()] = t.substring(eq + 1).trim()
  }
  return out
}
