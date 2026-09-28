package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.ChatMessage
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Floating search icon for the chat view.
 * Caller controls visibility via message count, e.g. `ChatSearchButton(messages.size > 15)`.
 */
@Composable
fun ChatSearchButton(visible: Boolean, onClick: () -> Unit) {
  if (!visible) return
  SmallFloatingActionButton(onClick = onClick, containerColor = NeonCyan) {
    Icon(Icons.Default.Search, contentDescription = "Search messages")
  }
}

/**
 * In-chat search field. Caller owns [query] state.
 * X clears the query and stays open; the explicit close button (or back)
 * closes the bar via [onClose].
 */
@Composable
fun ChatSearchBar(
  query: String,
  onQuery: (String) -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier
) {
  OutlinedTextField(
    value = query,
    onValueChange = onQuery,
    modifier = modifier.fillMaxWidth(),
    placeholder = { Text("Search messages", color = TextSecondary) },
    leadingIcon = { Icon(Icons.Default.Search, contentDescription = "Search", tint = TextSecondary) },
    trailingIcon = {
      androidx.compose.foundation.layout.Row {
        if (query.isNotEmpty()) {
          IconButton(onClick = { onQuery("") }) {
            Icon(Icons.Default.Clear, contentDescription = "Clear search", tint = TextSecondary)
          }
        }
        IconButton(onClick = onClose) {
          Icon(Icons.Default.Close, contentDescription = "Close search", tint = TextSecondary)
        }
      }
    },
    singleLine = true,
    colors = OutlinedTextFieldDefaults.colors(
      focusedTextColor = TextPrimary,
      unfocusedTextColor = TextPrimary,
      cursorColor = NeonCyan,
      focusedBorderColor = NeonCyan,
      unfocusedBorderColor = androidx.compose.ui.graphics.Color(0xFF1F2937)
    )
  )
}

/**
 * Empty state for search with no matches. Caller shows it when
 * `searchOpen && visibleChat.isEmpty() && searchQuery.isNotBlank()`.
 */
@Composable
fun ChatNoResults(
  query: String,
  modifier: Modifier = Modifier
) {
  Column(
    modifier.fillMaxWidth().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Text("No matches", color = TextPrimary, fontSize = 14.sp, fontFamily = FontFamily.Monospace)
    Spacer(Modifier.height(4.dp))
    Text(
      "Nothing found for \"$query\"",
      color = TextSecondary, fontSize = 12.sp, fontFamily = FontFamily.Monospace
    )
  }
}

/**
 * Client-side chat filter over content + thinking + sender, case-insensitive.
 * Blank query returns the full list.
 */
fun filterMessages(messages: List<ChatMessage>, query: String): List<ChatMessage> {
  if (query.isBlank()) return messages
  return messages.filter { m ->
    m.content.contains(query, ignoreCase = true) ||
      m.thinking.contains(query, ignoreCase = true) ||
      m.sender.contains(query, ignoreCase = true)
  }
}
