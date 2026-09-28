package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/** Approval scope buttons. mode values: "once" | "session" | "always". */
@Composable
fun ApprovalScopesRow(
    onAllow: (mode: String) -> Unit,
    onDeny: () -> Unit,
    modifier: Modifier = Modifier,
    fontScale: Float = 1f
) {
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        TextButton(onClick = { onAllow("once") }) {
            Text("Once", color = NeonGreen, fontSize = (12 * fontScale).sp)
        }
        TextButton(onClick = { onAllow("session") }) {
            Text("Session", color = NeonCyan, fontSize = (12 * fontScale).sp)
        }
        TextButton(onClick = { onAllow("always") }) {
            Text("Always", color = NeonViolet, fontSize = (12 * fontScale).sp)
        }
        TextButton(onClick = onDeny) {
            Text("Deny", color = NeonRed, fontSize = (12 * fontScale).sp)
        }
    }
}

/**
 * Single compact ChatTab status line: state + next action in one row.
 * Replaces stacked per-state banners. States:
 * streaming → "working · Ns" · offline → "OFFLINE · SETUP > START" ·
 * no session → "READY · type below to start" · else "LIVE · ready".
 */
@Composable
fun ChatStatusLine(
  connected: Boolean,
  streaming: Boolean,
  hasSession: Boolean,
  elapsedSecs: Long = 0L,
  modifier: Modifier = Modifier
) {
  val (dot, line) = when {
    streaming -> NeonAmber to "working · ${elapsedSecs}s"
    !connected -> NeonRed to "OFFLINE · SETUP > START"
    !hasSession -> NeonCyan to "READY · type below to start"
    else -> NeonGreen to "LIVE · ready"
  }
  Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Text("●", color = dot, fontSize = 11.sp)
    Spacer(Modifier.width(6.dp))
    Text(line, color = TextSecondary, fontSize = 11.sp,
      fontFamily = FontFamily.Monospace)
  }
}

/** Small mono model/duration footer for assistant messages. REAL data only:
 *  model = the session/model-picker model used for that turn, duration =
 *  client-measured turn time. Cost is deliberately OMITTED: no per-message
 *  cost source exists (Desktop has no per-message cost either). Renders
 *  nothing when both are empty/zero. */
@Composable
fun MessageFooter(
    modelName: String = "",
    durationMs: Long = 0L,
    modifier: Modifier = Modifier,
    fontScale: Float = 1f
) {
    val bits = buildList {
        if (modelName.isNotBlank()) add(modelName)
        if (durationMs > 0) add("${durationMs}ms")
    }
    if (bits.isEmpty()) return
    Text(
        bits.joinToString(" · "),
        color = TextSecondary, fontSize = (10 * fontScale).sp,
        fontFamily = FontFamily.Monospace, modifier = modifier
    )
}

/** Action row for user messages: regenerate / branch / copy. */
@Composable
fun MessageActionsRow(
    onRegenerate: () -> Unit,
    onBranch: () -> Unit,
    onCopy: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onRegenerate) {
            Text("Regen", color = NeonCyan, fontSize = 11.sp)
        }
        TextButton(onClick = onBranch) {
            Text("Branch", color = NeonViolet, fontSize = 11.sp)
        }
        TextButton(onClick = onCopy) {
            Text("Copy", color = TextSecondary, fontSize = 11.sp)
        }
    }
}
