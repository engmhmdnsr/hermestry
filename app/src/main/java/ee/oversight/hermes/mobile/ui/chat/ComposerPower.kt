package ee.oversight.hermes.mobile.ui.chat

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberBg
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/** One slash command: [trigger] typed in the composer, [label]/[hint] shown in UI. */
data class SlashCommand(val trigger: String, val label: String, val hint: String)

/** Bundled registry. App-specific extras come via [SlashCatalog]'s [custom] list. */
val BundledSlashCommands = listOf(
  SlashCommand("/new", "New session", "start a fresh session"),
  SlashCommand("/retry", "Retry last", "resend your last message"),
  SlashCommand("/models", "Models", "insert model picker prompt"),
  SlashCommand("/jobs", "Jobs", "insert jobs prompt"),
)

/**
 * Slash command UI. Blank draft → pill row;
 * typing a `/token` → filtered popover; tap fires [onCommand].
 *
 * Hook (ChatTab composer):
 *   SlashCatalog(text = text, onPick = { updateDraft(it) }, onCommand = ::handleSlash)
 */
@Composable
fun SlashCatalog(
  text: String,
  onPick: (String) -> Unit,
  onCommand: (SlashCommand) -> Unit = { onPick(it.trigger + " ") },
  custom: List<SlashCommand> = emptyList(),
  modifier: Modifier = Modifier
) {
  val all = remember(custom) { BundledSlashCommands + custom }
  if (text.isBlank()) {
    LazyRow(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      items(all) { cmd ->
        AssistChip(
          onClick = { onCommand(cmd) },
          label = { Text(cmd.trigger) },
          shape = RoundedCornerShape(16.dp),
          colors = AssistChipDefaults.assistChipColors(
            containerColor = CyberBg, labelColor = TextPrimary
          ),
          border = BorderStroke(1.dp, NeonViolet)
        )
      }
    }
    return
  }
  val token = text.substringAfterLast(' ').substringAfterLast('\n')
  if (!token.startsWith("/")) return
  val matches = all.filter { it.trigger.startsWith(token, ignoreCase = true) }
  if (matches.isEmpty()) return
  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    matches.forEach { cmd ->
      Card(
        colors = CardDefaults.cardColors(containerColor = CyberSurface),
        modifier = Modifier.fillMaxWidth().clickable { onCommand(cmd) }
      ) {
        Row(
          Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
          verticalAlignment = Alignment.CenterVertically
        ) {
          Text(cmd.trigger, color = NeonCyan, fontSize = 13.sp,
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
          Spacer(Modifier.width(8.dp))
          Column(Modifier.weight(1f)) {
            Text(cmd.label, color = TextPrimary, fontSize = 13.sp)
            if (cmd.hint.isNotBlank()) {
              Text(cmd.hint, color = TextSecondary, fontSize = 11.sp,
                fontFamily = FontFamily.Monospace)
            }
          }
        }
      }
    }
    Spacer(Modifier.height(2.dp))
  }
}

/** Plain-text mention tokens; parent appends the picked token to the draft. */
val MentionTokens = listOf("@file", "@folder", "@url", "@image", "@tool")

/**
 * Merged command row: slash pills + @mention chips in ONE horizontally
 * scrollable row with end content-padding so the last chip never clips
 * at the screen edge. Use when the draft is blank; active `/token`
 * typing still goes through [SlashCatalog]'s filtered popover.
 *
 * Hooks: onSlash fires the slash handler, onMention receives the bare
 * token (e.g. "@file") for the parent to append to the draft.
 */
@Composable
fun CommandPillsRow(
  onSlash: (SlashCommand) -> Unit,
  onMention: (String) -> Unit,
  modifier: Modifier = Modifier,
  slash: List<SlashCommand> = BundledSlashCommands,
  mentions: List<String> = MentionTokens
) {
  LazyRow(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    contentPadding = PaddingValues(end = 16.dp)
  ) {
    items(slash) { cmd ->
      AssistChip(
        onClick = { onSlash(cmd) },
        label = { Text(cmd.trigger) },
        shape = RoundedCornerShape(16.dp),
        colors = AssistChipDefaults.assistChipColors(
          containerColor = CyberBg, labelColor = TextPrimary
        ),
        border = BorderStroke(1.dp, NeonViolet)
      )
    }
    items(mentions) { token ->
      AssistChip(
        onClick = { onMention(token) },
        label = { Text(token, fontFamily = FontFamily.Monospace) },
        shape = RoundedCornerShape(16.dp),
        colors = AssistChipDefaults.assistChipColors(
          containerColor = CyberBg, labelColor = TextSecondary
        ),
        border = BorderStroke(1.dp, NeonCyan.copy(alpha = 0.5f))
      )
    }
  }
}

/**
 * Per-session composer draft persisted in the app prefs (same file the
 * ViewModel uses). Keyed `draft_<sessionId>` ("draft_none" when no session).
 */
object DraftStore {
  private const val PREFS = "hermes_mobile"
  private fun key(sessionId: String?) = "draft_" + (sessionId ?: "none")

  fun load(context: Context, sessionId: String?): String =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(key(sessionId), "").orEmpty()

  fun save(context: Context, sessionId: String?, draft: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putString(key(sessionId), draft).apply()
  }
}
