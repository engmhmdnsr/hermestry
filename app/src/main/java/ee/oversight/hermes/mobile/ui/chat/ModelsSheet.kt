package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.AiModelInfoV2
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceElevated
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.CyberTerminalBg
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Bottom sheet for picking a chat model.
 *
 * Signature:
 * `fun ModelsSheet(models: List<AiModelInfoV2>, selectedId: String, onSelect: (AiModelInfoV2) -> Unit, onDismiss: () -> Unit, fontScale: Float = 1f)`
 * Row tap calls `onSelect(model)` then `onDismiss()` so the sheet closes on pick.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelsSheet(
  models: List<AiModelInfoV2>,
  selectedId: String,
  onSelect: (AiModelInfoV2) -> Unit,
  onDismiss: () -> Unit,
  fontScale: Float = 1f
) {
  var query by remember { mutableStateOf("") }
  var providerFilter by remember { mutableStateOf("All") }
  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

  val providers = remember(models) {
    models.map { it.provider.ifBlank { "Other" } }.distinct().sorted()
  }

  val filtered = remember(models, query, providerFilter) {
    val q = query.trim().lowercase()
    models.filter { m ->
      val providerOk = providerFilter == "All" ||
        m.provider.ifBlank { "Other" } == providerFilter
      val queryOk = q.isEmpty() ||
        m.displayName.lowercase().contains(q) ||
        m.id.lowercase().contains(q) ||
        m.provider.lowercase().contains(q)
      providerOk && queryOk
    }
  }

  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = sheetState,
    containerColor = CyberSurface,
    contentColor = TextPrimary
  ) {
    Column(
      Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)
    ) {
      Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
      ) {
        Text(
          "Select model",
          color = TextPrimary,
          fontSize = (16 * fontScale).sp,
          fontFamily = FontFamily.Monospace,
          modifier = Modifier.weight(1f)
        )
        IconButton(onClick = onDismiss) {
          Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
        }
      }
      Spacer(Modifier.height(8.dp))
      OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        placeholder = { Text("Search name or provider…", color = TextSecondary) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextSecondary) },
        trailingIcon = {
          if (query.isNotEmpty()) {
            IconButton(onClick = { query = "" }) {
              Icon(Icons.Default.Close, contentDescription = "Clear search", tint = TextSecondary)
            }
          }
        },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
          focusedTextColor = TextPrimary,
          unfocusedTextColor = TextPrimary,
          focusedBorderColor = NeonCyan,
          unfocusedBorderColor = CyberSurfaceBorder,
          cursorColor = NeonCyan
        )
      )
      Spacer(Modifier.height(8.dp))
      LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
          ProviderChip(
            label = "All",
            selected = providerFilter == "All",
            onClick = { providerFilter = "All" }
          )
        }
        items(providers) { p ->
          ProviderChip(
            label = p,
            selected = providerFilter == p,
            onClick = { providerFilter = p }
          )
        }
      }
      Spacer(Modifier.height(8.dp))
      Text(
        if (models.isEmpty()) "No models available"
        else "${filtered.size} of ${models.size} models",
        color = TextSecondary,
        fontSize = (12 * fontScale).sp,
        fontFamily = FontFamily.Monospace
      )
      Spacer(Modifier.height(8.dp))
      if (models.isEmpty()) {
        Text(
          "No models available.",
          color = TextSecondary,
          fontSize = (13 * fontScale).sp,
          modifier = Modifier.fillMaxWidth()
            .background(CyberTerminalBg, RoundedCornerShape(8.dp))
            .padding(12.dp)
        )
      } else if (filtered.isEmpty()) {
        Text(
          "No models match your filters.",
          color = TextSecondary,
          fontSize = (13 * fontScale).sp,
          modifier = Modifier.fillMaxWidth()
            .background(CyberTerminalBg, RoundedCornerShape(8.dp))
            .padding(12.dp)
        )
      } else {
        LazyColumn(
          verticalArrangement = Arrangement.spacedBy(6.dp),
          modifier = Modifier.weight(1f, fill = false)
        ) {
          items(filtered, key = { it.id }) { m ->
            val selected = m.id == selectedId
            Row(
              Modifier.fillMaxWidth()
                .background(
                  if (selected) CyberSurfaceElevated else CyberTerminalBg,
                  RoundedCornerShape(8.dp)
                )
                .clickable { onSelect(m); onDismiss() }
                .padding(12.dp),
              verticalAlignment = Alignment.CenterVertically
            ) {
              Column(Modifier.weight(1f)) {
                Text(
                  m.displayName.ifBlank { m.id },
                  color = if (selected) NeonGreen else TextPrimary,
                  fontSize = (14 * fontScale).sp,
                  fontFamily = FontFamily.Monospace
                )
                if (m.provider.isNotBlank()) {
                  Text(m.provider, color = NeonCyan, fontSize = (11 * fontScale).sp)
                }
                if (m.description.isNotBlank()) {
                  Text(m.description, color = TextSecondary, fontSize = (12 * fontScale).sp, maxLines = 2)
                }
              }
              if (selected) {
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Default.Check, contentDescription = "Selected", tint = NeonGreen)
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun ProviderChip(label: String, selected: Boolean, onClick: () -> Unit) {
  FilterChip(
    selected = selected,
    onClick = onClick,
    label = { Text(label, fontSize = 12.sp, fontFamily = FontFamily.Monospace) },
    colors = FilterChipDefaults.filterChipColors(
      containerColor = CyberTerminalBg,
      labelColor = TextSecondary,
      selectedContainerColor = CyberSurfaceElevated,
      selectedLabelColor = NeonCyan
    )
  )
}
