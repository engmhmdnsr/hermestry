package ee.oversight.hermes.mobile.ui.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonVioletLight
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Search field for filtering the drawer sessions list.
 * Pure callback-driven: caller owns the query state.
 */
@Composable
fun SessionSearchBar(
  query: String,
  onQueryChange: (String) -> Unit,
  modifier: Modifier = Modifier
) {
  OutlinedTextField(
    value = query,
    onValueChange = onQueryChange,
    modifier = modifier.fillMaxWidth(),
    placeholder = { Text("Search sessions", color = TextSecondary) },
    leadingIcon = { Icon(Icons.Default.Search, contentDescription = "Search", tint = TextSecondary) },
    trailingIcon = {
      if (query.isNotEmpty()) {
        IconButton(onClick = { onQueryChange("") }) {
          Icon(Icons.Default.Clear, contentDescription = "Clear", tint = TextSecondary)
        }
      }
    },
    singleLine = true,
    colors = OutlinedTextFieldDefaults.colors(
      focusedTextColor = TextPrimary(),
      unfocusedTextColor = TextPrimary(),
      cursorColor = NeonCyan,
      focusedBorderColor = NeonCyan,
      unfocusedBorderColor = androidx.compose.ui.graphics.Color(0xFF1F2937)
    )
  )
}

@Composable
private fun TextPrimary() = ee.oversight.hermes.mobile.ui.theme.TextPrimary

/**
 * Rename dialog for a session. Caller owns visibility; this renders the dialog itself.
 *
 * @param sessionId id of the session being renamed (for the confirm callback)
 * @param current current title, used as the initial text
 * @param onConfirm called with (sessionId, newTitle) on Save
 * @param onDismiss called on Cancel / dismiss
 */
@Composable
fun RenameDialog(
  sessionId: String,
  current: String,
  onConfirm: (sessionId: String, newTitle: String) -> Unit,
  onDismiss: () -> Unit
) {
  var text by remember(sessionId, current) { mutableStateOf(current) }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("Rename session") },
    text = {
      OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        placeholder = { Text("Session title", color = TextSecondary) }
      )
    },
    confirmButton = {
      TextButton(
        onClick = { onConfirm(sessionId, text.trim()) },
        enabled = text.trim().isNotEmpty() && text.trim() != current
      ) { Text("Save", color = NeonCyan) }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) { Text("Cancel", color = TextSecondary) }
    }
  )
}

/**
 * Row action buttons for a session in the drawer list.
 * No ViewModel dependency — wire onRename to show RenameDialog,
 * onFork to vm.forkSession(id) from the owning screen.
 */
@Composable
fun SessionRowActions(
  sessionId: String,
  onRename: (sessionId: String) -> Unit,
  onFork: (sessionId: String) -> Unit,
  modifier: Modifier = Modifier
) {
  Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(0.dp)) {
    IconButton(onClick = { onRename(sessionId) }) {
      Icon(Icons.Default.Edit, contentDescription = "Rename", tint = NeonVioletLight)
    }
    IconButton(onClick = { onFork(sessionId) }) {
      Icon(Icons.Default.ContentCopy, contentDescription = "Fork", tint = NeonCyan)
    }
  }
}
