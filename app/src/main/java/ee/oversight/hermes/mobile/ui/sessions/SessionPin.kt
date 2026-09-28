package ee.oversight.hermes.mobile.ui.sessions

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.ChatMessage
import ee.oversight.hermes.mobile.model.MobileSession
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Pinned-session IDs, ported from Control's HermesPreferencesRepository
 * pinned-sessions set (CSV in the shared "hermes_mobile" prefs file).
 */
object SessionPinStore {
  private const val KEY_PINNED = "pref_pinned_sessions"

  private fun prefs(context: Context) =
    context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)

  fun getPinnedIds(context: Context): Set<String> {
    val raw = prefs(context).getString(KEY_PINNED, "") ?: ""
    if (raw.isBlank()) return emptySet()
    return raw.split(",").filter { it.isNotBlank() }.toSet()
  }

  fun setPinnedIds(context: Context, ids: Set<String>) {
    prefs(context).edit().putString(KEY_PINNED, ids.joinToString(",")).apply()
  }

  fun isPinned(context: Context, sessionId: String): Boolean =
    getPinnedIds(context).contains(sessionId)

  /** Toggles the pin; returns the new pinned state. */
  fun toggle(context: Context, sessionId: String): Boolean {
    val ids = getPinnedIds(context).toMutableSet()
    val nowPinned = if (ids.contains(sessionId)) {
      ids.remove(sessionId)
      false
    } else {
      ids.add(sessionId)
      true
    }
    setPinnedIds(context, ids)
    return nowPinned
  }

  /** Drops pins for sessions that no longer exist (deleted on the server or
   * gone after a refresh); returns the pruned set. */
  fun prune(context: Context, validIds: Set<String>): Set<String> {
    val pruned = getPinnedIds(context).intersect(validIds)
    setPinnedIds(context, pruned)
    return pruned
  }
}

/**
 * Splits [sessions] into pinned-first ordering and renders a "Pinned"
 * header above the pinned rows. Pure layout wrapper: the caller supplies
 * row content for each session and owns pin-toggle state.
 *
 * Hook: `val pinned = SessionPinStore.getPinnedIds(ctx)` then
 * `PinnedSection(sessions, pinned, onTogglePin = { ... }, rowContent = { ... })`.
 */
@Composable
fun PinnedSection(
  sessions: List<MobileSession>,
  pinnedIds: Set<String>,
  modifier: Modifier = Modifier,
  onTogglePin: (MobileSession) -> Unit = {},
  rowContent: @Composable (session: MobileSession, isPinned: Boolean, onTogglePin: () -> Unit) -> Unit
) {
  val pinned = sessions.filter { pinnedIds.contains(it.id) }
  val rest = sessions.filter { !pinnedIds.contains(it.id) }
  Column(modifier = modifier) {
    if (pinned.isNotEmpty()) {
      Text(
        "\uD83D\uDCCC PINNED (${pinned.size})",
        fontSize = 11.sp,
        color = NeonAmber,
        fontFamily = FontFamily.Monospace
      )
      Spacer(Modifier.height(4.dp))
      pinned.forEach { s ->
        rowContent(s, true) { onTogglePin(s) }
      }
      Spacer(Modifier.height(8.dp))
    }
    rest.forEach { s ->
      rowContent(s, false) { onTogglePin(s) }
    }
  }
}

/**
 * Pure markdown builder for a session transcript, mirroring Control's
 * `exportSessionAsMarkdown` body (title header, id, date, per-message
 * User/Hermes sections with tool blocks).
 *
 * Hook: `val md = exportSessionMarkdown(title, id, messages)` then share via
 * `ACTION_SEND` intent with `EXTRA_TEXT = md`.
 */
fun exportSessionMarkdown(
  sessionTitle: String,
  sessionId: String,
  messages: List<ChatMessage>,
  now: Date = Date()
): String {
  val sb = StringBuilder("# Hermes Session: $sessionTitle\n")
  sb.append("ID: $sessionId\n")
  sb.append("Date: ${SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(now)}\n\n---\n\n")
  messages.forEach { m ->
    val senderName = if (m.sender == "you") "### \uD83D\uDC64 User" else "### \uD83E\uDD16 Hermes"
    sb.append("$senderName\n")
    sb.append("${m.content}\n\n")
    if (m.tools.isNotEmpty()) {
      m.tools.forEach { tool ->
        sb.append("```bash\n# [TOOL]\n$tool\n```\n\n")
      }
    }
  }
  return sb.toString()
}
