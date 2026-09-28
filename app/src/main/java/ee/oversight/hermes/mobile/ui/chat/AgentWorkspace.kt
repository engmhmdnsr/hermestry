package ee.oversight.hermes.mobile.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.model.ToolExecution
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceBorder
import ee.oversight.hermes.mobile.ui.theme.CyberSurfaceElevated
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.NeonVioletLight
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary

/**
 * Agent Workspace identity for the Chat tab (Phase 1 redesign).
 *
 * NOTE: ui/theme holds no AppColors/AgentStatus yet (sibling owns it), so this
 * file uses the legacy theme tokens. Swap to AppColors and the shared
 * AgentStatusBadge when the sibling lands them.
 *
 * Behavior lives in MainActivity ChatTab / the VM; everything here is pure
 * presentation. ThinkingBlock, ToolExecutionsBlock, StreamingControls and
 * ModelsSheet logic is untouched, these components only re-skin containers.
 */

/** Status pill: badge, never raw CONNECTED text. */
@Composable
fun AgentStatusBadge(
  connected: Boolean,
  streaming: Boolean,
  elapsedSecs: Long = 0L,
  modifier: Modifier = Modifier
) {
  val (dot, label, tint) = when {
    streaming -> Triple(NeonAmber, "WORKING ${elapsedSecs}s", NeonAmber)
    !connected -> Triple(NeonRed, "OFFLINE", NeonRed)
    else -> Triple(NeonGreen, "LIVE", NeonGreen)
  }
  Row(
    modifier
      .background(tint.copy(alpha = 0.12f), RoundedCornerShape(999.dp))
      .border(1.dp, tint.copy(alpha = 0.45f), RoundedCornerShape(999.dp))
      .padding(horizontal = 10.dp, vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Text("●", color = dot, fontSize = 9.sp)
    Spacer(Modifier.width(6.dp))
    Text(label, color = tint, fontSize = 11.sp,
      fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
  }
}

/**
 * Top agent header: agent name + status badge + current model.
 * Replaces the old one-line ChatStatusLine usage in ChatTab.
 */
@Composable
fun AgentHeader(
  connected: Boolean,
  streaming: Boolean,
  hasSession: Boolean,
  modelName: String,
  elapsedSecs: Long = 0L,
  onOpenModels: () -> Unit = {},
  modifier: Modifier = Modifier
) {
  Column(modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text("HERMES", color = TextPrimary, fontSize = 16.sp,
          fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        Text(
          if (modelName.isNotBlank()) modelName else "agent workspace",
          color = TextSecondary, fontSize = 11.sp,
          fontFamily = FontFamily.Monospace,
          maxLines = 1, overflow = TextOverflow.Ellipsis
        )
      }
      AgentStatusBadge(connected = connected, streaming = streaming, elapsedSecs = elapsedSecs)
    }
    Spacer(Modifier.height(6.dp))
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      val hint = when {
        streaming -> "working on your request"
        !connected -> "gateway offline, start it in Settings"
        !hasSession -> "ready, type below to start a session"
        else -> "ready"
      }
      Text(hint, color = TextSecondary, fontSize = 11.sp,
        fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
      if (modelName.isNotBlank()) {
        TextButton(onClick = onOpenModels) {
          Text("MODEL", color = NeonCyan, fontSize = 11.sp,
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
        }
      }
    }
  }
}

/** Sender label above a message group: USER for own turns, HERMES for agent. */
@Composable
fun SenderLabel(isUser: Boolean, modifier: Modifier = Modifier) {
  Text(
    if (isUser) "USER" else "HERMES",
    color = if (isUser) NeonVioletLight else NeonCyan,
    fontSize = 10.sp, fontFamily = FontFamily.Monospace,
    fontWeight = FontWeight.Bold,
    modifier = modifier.padding(bottom = 4.dp)
  )
}

/**
 * New skin around [ToolExecutionsBlock]: status icon in the header, card
 * surface. Expand/collapse behavior is owned by ToolExecutionsBlock.
 */
@Composable
fun WorkspaceToolCard(
  tools: List<ToolExecution>,
  isStreaming: Boolean,
  modifier: Modifier = Modifier,
  fontScale: Float = 1f
) {
  if (tools.isEmpty()) return
  val failed = tools.any { it.status.lowercase() in listOf("failed", "error") }
  val running = tools.any { it.status.lowercase() in listOf("running", "started", "pending") }
  val (icon, tint) = when {
    failed -> "▲" to NeonRed
    running -> "●" to NeonCyan
    else -> "✓" to NeonGreen
  }
  Column(
    modifier.fillMaxWidth()
      .background(CyberSurfaceElevated.copy(alpha = 0.6f), RoundedCornerShape(10.dp))
      .border(1.dp, tint.copy(alpha = 0.3f), RoundedCornerShape(10.dp))
      .padding(horizontal = 10.dp, vertical = 6.dp)
  ) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Text(icon, color = tint, fontSize = (11 * fontScale).sp)
      Spacer(Modifier.width(6.dp))
      Text("TOOLS · ${tools.size}", color = tint, fontSize = (10 * fontScale).sp,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
    }
    ToolExecutionsBlock(tools = tools, isStreaming = isStreaming, fontScale = fontScale)
  }
}

/**
 * PROMINENT approval card: full-width elevated card, amber border, big
 * DENY / APPROVE buttons. Scope choice (once/session/always) stays via
 * [ApprovalScopesRow]. Same onAllow(mode)/onDeny callbacks as before.
 */
@Composable
fun ProminentApprovalCard(
  summary: String,
  onAllow: (mode: String) -> Unit,
  onDeny: () -> Unit,
  modifier: Modifier = Modifier
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = CyberSurfaceElevated),
    border = androidx.compose.foundation.BorderStroke(2.dp, NeonAmber.copy(alpha = 0.8f)),
    shape = RoundedCornerShape(16.dp),
    modifier = modifier.fillMaxWidth()
  ) {
    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("◆", color = NeonAmber, fontSize = 16.sp)
        Spacer(Modifier.width(8.dp))
        Text("APPROVAL NEEDED", color = NeonAmber, fontSize = 14.sp,
          fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
      }
      if (summary.isNotBlank()) {
        Text(summary.take(500), color = TextPrimary, fontSize = 13.sp,
          fontFamily = FontFamily.Monospace,
          maxLines = 6, overflow = TextOverflow.Ellipsis,
          modifier = Modifier.fillMaxWidth()
            .background(CyberSurface, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp))
      }
      Text("The agent is waiting. Approve once, or deny to stop it.",
        color = TextSecondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
          onClick = onDeny,
          border = androidx.compose.foundation.BorderStroke(1.5.dp, NeonRed),
          shape = RoundedCornerShape(12.dp),
          modifier = Modifier.weight(1f).height(52.dp)
        ) {
          Text("DENY", color = NeonRed, fontSize = 15.sp,
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
        }
        Button(
          onClick = { onAllow("once") },
          colors = ButtonDefaults.buttonColors(
            containerColor = NeonGreen, contentColor = Color.Black),
          shape = RoundedCornerShape(12.dp),
          modifier = Modifier.weight(1f).height(52.dp)
        ) {
          Text("APPROVE", fontSize = 15.sp,
            fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
        }
      }
      ApprovalScopesRow(
        onAllow = onAllow, onDeny = onDeny,
        modifier = Modifier.fillMaxWidth()
          .horizontalScroll(rememberScrollState())
      )
      Text("Approve: Once · Session · Always (above row). Deny is final for this request.",
        color = TextSecondary, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
    }
  }
}

/** Honest empty state + suggestion chips that fill the draft (no fake send). */
@Composable
fun WorkspaceEmptyState(
  connected: Boolean,
  onGoSettings: () -> Unit,
  onSuggest: (String) -> Unit,
  modifier: Modifier = Modifier
) {
  Column(modifier.fillMaxWidth().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center) {
    Text(if (connected) "//" else "◌",
      color = if (connected) NeonCyan else NeonRed, fontSize = 40.sp,
      fontFamily = FontFamily.Monospace)
    Spacer(Modifier.height(12.dp))
    Text(if (connected) "Agent workspace" else "Gateway offline",
      color = TextPrimary, fontSize = 16.sp,
      fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
    Spacer(Modifier.height(6.dp))
    Text(if (connected) "No messages yet. Type below, sending starts a session."
      else "Start the gateway, then chat here.",
      color = TextSecondary, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    if (connected) {
      Spacer(Modifier.height(14.dp))
      val suggestions = listOf(
        "Summarize this repo" to "Summarize the current project for me.",
        "Check status" to "Check the gateway status and report what is running.",
        "New idea" to "Brainstorm three ideas for "
      )
      suggestions.forEach { (label, draft) ->
        OutlinedButton(
          onClick = { onSuggest(draft) },
          border = androidx.compose.foundation.BorderStroke(1.dp, CyberSurfaceBorder),
          shape = RoundedCornerShape(999.dp),
          modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)
        ) {
          Text(label, color = NeonCyan, fontSize = 12.sp,
            fontFamily = FontFamily.Monospace, maxLines = 1,
            overflow = TextOverflow.Ellipsis)
        }
      }
    } else {
      Spacer(Modifier.height(14.dp))
      Button(
        onClick = onGoSettings,
        colors = ButtonDefaults.buttonColors(
          containerColor = NeonViolet, contentColor = Color.White)
      ) { Text("Go to Settings") }
    }
  }
}

/** Failed-turn banner with retry. Shown above the composer, never inline. */
@Composable
fun TurnErrorBanner(
  message: String,
  onRetry: () -> Unit,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier
) {
  Row(
    modifier.fillMaxWidth()
      .background(NeonRed.copy(alpha = 0.12f), RoundedCornerShape(10.dp))
      .border(1.dp, NeonRed.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
      .padding(horizontal = 10.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Column(Modifier.weight(1f)) {
      Text("SEND FAILED", color = NeonRed, fontSize = 11.sp,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
      Text(message.take(200), color = TextPrimary, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace,
        maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    Spacer(Modifier.width(8.dp))
    Button(
      onClick = onRetry,
      colors = ButtonDefaults.buttonColors(
        containerColor = NeonRed, contentColor = Color.White),
      shape = RoundedCornerShape(10.dp)
    ) {
      Text("RETRY", fontSize = 12.sp,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
    }
    Text("✕", color = TextSecondary, fontSize = 14.sp,
      modifier = Modifier.clickable { onDismiss() }.padding(start = 8.dp))
  }
}
