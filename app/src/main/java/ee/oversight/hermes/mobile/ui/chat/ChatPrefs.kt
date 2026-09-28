package ee.oversight.hermes.mobile.ui.chat

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Chat preferences ported from Control (HermesPreferencesRepository keys,
 * GatewayConfigScreen font slider, CyberpunkTopBar auto-approve pill,
 * reasoning-effort selector).
 *
 * Hook (e.g. in your ViewModel init):
 * ```
 * ChatFontScale.value = loadChatFontScale(ctx)
 * AutoApproveState.global = loadGlobalAutoApprove(ctx)
 * ReasoningEffort.selected.value = loadReasoningEffort(ctx)
 * ```
 */

/** Global chat font scale (0.6–1.4), applied by chat message UI as `sp * value`. */
val ChatFontScale: MutableState<Float> = mutableStateOf(1f)

private const val KEY_FONT = "pref_chat_font_scale"
private const val KEY_GLOBAL_APPROVE = "pref_global_auto_approve"
private const val KEY_SESSION_APPROVE_PREFIX = "pref_session_auto_approve_"
private const val KEY_EFFORT = "pref_reasoning_effort"

fun loadChatFontScale(context: Context): Float =
  context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
    .getFloat(KEY_FONT, 1f).coerceIn(0.6f, 1.4f)

fun saveChatFontScale(context: Context, scale: Float) {
  val clamped = scale.coerceIn(0.6f, 1.4f)
  context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
    .edit().putFloat(KEY_FONT, clamped).apply()
  ChatFontScale.value = clamped
}

/** Font-size slider row (Control: "CHAT FONT SIZE" section). */
@Composable
fun ChatFontSizeRow(
  scale: Float = ChatFontScale.value,
  onScaleChange: (Float) -> Unit = { ChatFontScale.value = it.coerceIn(0.6f, 1.4f) },
  modifier: Modifier = Modifier
) {
  Column(modifier = modifier.fillMaxWidth()) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Icon(Icons.Default.TextFields, null, tint = NeonCyan, modifier = Modifier.size(16.dp))
      Spacer(Modifier.width(6.dp))
      Text("CHAT FONT SIZE", fontSize = 12.sp, color = NeonCyan, fontFamily = FontFamily.Monospace)
    }
    Spacer(Modifier.height(4.dp))
    Text(
      "Scales chat message text only",
      fontSize = 10.sp,
      color = TextSecondary,
      fontFamily = FontFamily.Monospace
    )
    Text(
      "Preview: chat messages will look like this",
      fontSize = (13.5f * scale).sp,
      color = TextPrimary,
      fontFamily = FontFamily.Monospace
    )
    Spacer(Modifier.height(4.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      IconButton(onClick = { onScaleChange(scale - 0.05f) }, modifier = Modifier.size(36.dp)) {
        Icon(Icons.Default.Remove, null, tint = NeonCyan, modifier = Modifier.size(18.dp))
      }
      Slider(
        value = scale,
        onValueChange = onScaleChange,
        valueRange = 0.6f..1.4f,
        steps = 15,
        modifier = Modifier.weight(1f),
        colors = SliderDefaults.colors(
          thumbColor = NeonCyan,
          activeTrackColor = NeonCyan,
          inactiveTrackColor = CyberSurfaceBorder
        )
      )
      IconButton(onClick = { onScaleChange(scale + 0.05f) }, modifier = Modifier.size(36.dp)) {
        Icon(Icons.Default.Add, null, tint = NeonCyan, modifier = Modifier.size(18.dp))
      }
    }
    Text(
      "${(scale * 100).toInt()}%",
      fontSize = 11.sp,
      fontWeight = FontWeight.Bold,
      color = NeonCyan,
      fontFamily = FontFamily.Monospace,
      modifier = Modifier.fillMaxWidth(),
      textAlign = TextAlign.Center
    )
  }
}

/** Global + per-session auto-approve state (Control: ApprovalMode/global pill). */
object AutoApproveState {
  /** Global "allow all" switch. */
  var global: Boolean = false

  fun loadGlobal(context: Context): Boolean {
    global = context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .getBoolean(KEY_GLOBAL_APPROVE, false)
    return global
  }

  fun saveGlobal(context: Context, enabled: Boolean) {
    global = enabled
    context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .edit().putBoolean(KEY_GLOBAL_APPROVE, enabled).apply()
  }

  fun isSessionApproved(context: Context, sessionId: String): Boolean =
    context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .getBoolean(KEY_SESSION_APPROVE_PREFIX + sessionId, false)

  fun setSessionApproved(context: Context, sessionId: String, approved: Boolean) {
    context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .edit().putBoolean(KEY_SESSION_APPROVE_PREFIX + sessionId, approved).apply()
  }

  fun loadGlobalAutoApprove(context: Context): Boolean = loadGlobal(context)
}

/** Auto-approve status pill (Control: CyberpunkTopBar ⚡ AUTO-ALL / SESS-AUTO). */
@Composable
fun AutoApprovePill(
  globalAutoApprove: Boolean = AutoApproveState.global,
  isSessionAutoApproved: Boolean = false,
  onToggleGlobal: ((Boolean) -> Unit)? = null,
  modifier: Modifier = Modifier
) {
  val label = when {
    globalAutoApprove -> "⚡ AUTO-ALL"
    isSessionAutoApproved -> "⚡ SESS-AUTO"
    else -> "MANUAL"
  }
  val border = when {
    globalAutoApprove -> NeonRed
    isSessionAutoApproved -> NeonAmber.copy(alpha = 0.5f)
    else -> NeonViolet
  }
  Box(
    modifier = modifier
      .clip(RoundedCornerShape(8.dp))
      .background(
        when {
          globalAutoApprove -> NeonRed.copy(alpha = 0.15f)
          isSessionAutoApproved -> NeonAmber.copy(alpha = 0.12f)
          else -> NeonViolet.copy(alpha = 0.2f)
        }
      )
      .border(1.dp, border, RoundedCornerShape(8.dp))
      .clickable(enabled = onToggleGlobal != null) { onToggleGlobal?.invoke(!globalAutoApprove) }
      .padding(horizontal = 10.dp, vertical = 6.dp)
  ) {
    Text(label, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = border, fontFamily = FontFamily.Monospace)
  }
}

/** Reasoning-effort options (Control: none/low/medium/high). */
object ReasoningEffort {
  val OPTIONS = listOf("none", "low", "medium", "high")
  val selected: MutableState<String> = mutableStateOf("medium")

  fun load(context: Context): String {
    val v = context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .getString(KEY_EFFORT, "medium") ?: "medium"
    selected.value = if (v.lowercase() in OPTIONS) v.lowercase() else "medium"
    return selected.value
  }

  fun save(context: Context, effort: String) {
    val normalized = if (effort.lowercase() in OPTIONS) effort.lowercase() else "medium"
    selected.value = normalized
    context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .edit().putString(KEY_EFFORT, normalized).apply()
  }
}

fun loadReasoningEffort(context: Context): String = ReasoningEffort.load(context)

/** Reasoning-effort selector row (Control: effort pill next to model picker). */
@Composable
fun ReasoningEffortRow(
  effort: String = ReasoningEffort.selected.value,
  onEffortSelected: (String) -> Unit = { ReasoningEffort.selected.value = it },
  modifier: Modifier = Modifier
) {
  Column(modifier = modifier.fillMaxWidth()) {
    Text("REASONING EFFORT", fontSize = 12.sp, color = NeonCyan, fontFamily = FontFamily.Monospace)
    Spacer(Modifier.height(6.dp))
    Row(
      modifier = Modifier.horizontalScroll(rememberScrollState()),
      horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
      ReasoningEffort.OPTIONS.forEach { option ->
        FilterChip(
          selected = effort == option,
          onClick = { onEffortSelected(option) },
          label = {
            Text(option.uppercase(), fontSize = 11.sp, fontFamily = FontFamily.Monospace)
          },
          colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = NeonViolet.copy(alpha = 0.3f),
            selectedLabelColor = TextPrimary,
            containerColor = CyberSurfaceBorder.copy(alpha = 0.4f),
            labelColor = TextSecondary
          )
        )
      }
    }
  }
}
