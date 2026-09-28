package ee.oversight.hermes.mobile.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.InstallState
import ee.oversight.hermes.mobile.MobileViewModel
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet

// Local identity colors (Phase 1 spec: #0B0D0F / #12161A / #F1F3F5).
// NOTE for the ui/theme owner: if AppColors lands, swap HomeBg/HomeSurface/
// HomeText for it and delete these three lines. Neon accents stay shared.
private val HomeBg = Color(0xFF0B0D0F)
private val HomeSurface = Color(0xFF12161A)
private val HomeText = Color(0xFFF1F3F5)
private val HomeDim = Color(0xFF9AA4B2)
private val HomeBorder = Color(0xFF232A33)

/** Agent presence shown on the Home status card. THINKING vs EXECUTING is
 *  derived from the live chat tail (see agentStatusFor). */
enum class AgentStatus {
  ONLINE, THINKING, EXECUTING, WAITING, OFFLINE, CONNECTING, ERROR
}

private fun statusColor(s: AgentStatus): Color = when (s) {
  AgentStatus.ONLINE -> NeonGreen
  AgentStatus.THINKING -> NeonCyan
  AgentStatus.EXECUTING -> NeonViolet
  AgentStatus.WAITING -> NeonAmber
  AgentStatus.OFFLINE -> HomeDim
  AgentStatus.CONNECTING -> NeonAmber
  AgentStatus.ERROR -> NeonRed
}

private fun statusDot(s: AgentStatus): String = when (s) {
  AgentStatus.ONLINE -> "●"
  AgentStatus.THINKING -> "◐"
  AgentStatus.EXECUTING -> "▶"
  AgentStatus.WAITING -> "!"
  AgentStatus.OFFLINE -> "◌"
  AgentStatus.CONNECTING -> "…"
  AgentStatus.ERROR -> "✕"
}

/** Compact relative time: 1690000000000 -> "5m ago". */
fun homeAgo(ts: Long): String {
  if (ts <= 0L) return "never"
  val s = (System.currentTimeMillis() - ts) / 1000
  if (s < 0) return "just now"
  return when {
    s < 60 -> "just now"
    s < 3600 -> "${s / 60}m ago"
    s < 86400 -> "${s / 3600}h ago"
    else -> "${s / 86400}d ago"
  }
}

@Composable
fun HomeTab(
  vm: MobileViewModel,
  onGoChat: () -> Unit,
  onRunCommand: () -> Unit,
  onGoActivity: () -> Unit,
  onGoSettings: () -> Unit
) {
  val connected by vm.connected.collectAsState()
  val streaming by vm.streaming.collectAsState()
  val approvals by vm.approvals.collectAsState()
  val install by vm.install.collectAsState()
  val sessions by vm.sessions.collectAsState()
  val jobs by vm.jobs.collectAsState()
  val chat by vm.chat.collectAsState()
  val gwFailed by vm.gatewayFailed.collectAsState()
  val gwReason by vm.gatewayFailureReason.collectAsState()
  val currentId by vm.currentSessionId.collectAsState()

  // Last-seen timestamp for the error state: last moment health passed.
  var lastSeenMs by remember { mutableLongStateOf(0L) }
  LaunchedEffect(connected) {
    if (connected) lastSeenMs = System.currentTimeMillis()
  }

  val status = agentStatusFor(
    connected = connected,
    streaming = streaming,
    approvalsPending = approvals.isNotEmpty(),
    install = install,
    gatewayFailed = gwFailed,
    tailWaitingOnUser = chat.lastOrNull()?.sender == "you",
    tailHermesBlank = chat.lastOrNull()?.let { it.sender != "you" && it.content.isBlank() } ?: true
  )
  val showError = gwFailed || install == InstallState.FAILED
  val hasWork = streaming || sessions.isNotEmpty() || jobs.isNotEmpty()

  // Current task line: live turn wins, else the latest session.
  val currentTask: String? = when {
    streaming -> {
      val lastUser = chat.lastOrNull { it.sender == "you" }?.content
        ?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()?.take(120)
      if (lastUser.isNullOrBlank()) "Streaming a turn…" else "Streaming: $lastUser"
    }
    else -> sessions.maxByOrNull { it.lastActiveAt }?.let { s ->
      val t = s.title.ifBlank { "untitled" }.take(120)
      "$t · ${s.messageCount} msgs · ${homeAgo(s.lastActiveAt)}"
    }
  }

  LazyColumn(
    modifier = Modifier.fillMaxSize().background(HomeBg).padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
    contentPadding = PaddingValues(top = 12.dp, bottom = 96.dp)
  ) {
    item {
      Text("// HOME", color = NeonCyan, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    }

    // (1) Agent status card, always first.
    item {
      AgentStatusCard(
        status = status,
        currentTask = currentTask,
        approvalsPending = approvals.size,
        onOpenChat = onGoChat
      )
    }

    // Error state: explicit, with last-seen + Retry + Connection Settings.
    // Never a bare spinner: every branch below renders text + actions.
    if (showError) {
      item {
        ConnectionErrorCard(
          lastSeenMs = lastSeenMs,
          reason = gwReason,
          onRetry = {
            if (install == InstallState.INSTALLED || install == InstallState.FAILED) vm.start()
            else vm.coldStart()
          },
          onSettings = onGoSettings
        )
      }
    }

    // (2) Quick actions row.
    item {
      Text("QUICK ACTIONS", color = HomeDim, fontSize = 11.sp,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
      Spacer(Modifier.height(8.dp))
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
      ) {
        QuickAction(
          label = "Chat",
          sub = "Talk to Hermes",
          icon = Icons.Filled.ChatBubbleOutline,
          enabled = true,
          onClick = onGoChat,
          modifier = Modifier.weight(1f)
        )
        QuickAction(
          label = "Command",
          sub = "Run in chat",
          icon = Icons.Filled.Terminal,
          enabled = true,
          onClick = onRunCommand,
          modifier = Modifier.weight(1f)
        )
        QuickAction(
          label = "Tasks",
          sub = if (jobs.isEmpty()) "None yet" else "${jobs.size} scheduled",
          icon = Icons.Filled.PlayArrow,
          enabled = true,
          onClick = onGoActivity,
          modifier = Modifier.weight(1f)
        )
        // No files feature exists on the gateway, so this stays a disabled
        // placeholder with a coming-soon note instead of a dead button.
        QuickAction(
          label = "Files",
          sub = "Coming soon",
          icon = Icons.Filled.Folder,
          enabled = false,
          onClick = {},
          modifier = Modifier.weight(1f)
        )
      }
    }

    // (3) Tasks / recent activity.
    if (!hasWork) {
      item {
        EmptyTasksCard(onStart = { vm.newSession(); onGoChat() })
      }
    } else {
      item {
        val liveCount = (if (streaming) 1 else 0) + approvals.size
        Text(
          if (liveCount > 0) "ACTIVE NOW ($liveCount)" else "RECENT ACTIVITY",
          color = HomeDim, fontSize = 11.sp,
          fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold
        )
        Spacer(Modifier.height(8.dp))
      }
      val recentSessions = sessions.sortedByDescending { it.lastActiveAt }.take(5)
      recentSessions.forEach { s ->
        val active = streaming && s.id == currentId
        item(key = "sess-${s.id}") {
          RecentSessionRow(
            title = s.title.ifBlank { "untitled" },
            meta = "${s.messageCount} msgs · ${homeAgo(s.lastActiveAt)}",
            active = active,
            onClick = { vm.selectSession(s.id); onGoChat() }
          )
        }
      }
      val recentJobs = jobs.take(3)
      recentJobs.forEach { j ->
        item(key = "job-${j.id}") {
          RecentJobRow(
            name = j.name,
            meta = "${j.scheduleDisplay} · ${j.state.ifBlank { if (j.enabled) "active" else "paused" }}",
            failed = j.lastStatus.lowercase() in listOf("failed", "error") ||
              (j.lastStatus.isBlank() && j.lastError.isNotBlank()),
            onClick = onGoActivity
          )
        }
      }
    }
  }
}

/** Presence derivation shared by the status card. Order matters: failure
 *  first, then anything that needs the user, then liveness. */
fun agentStatusFor(
  connected: Boolean,
  streaming: Boolean,
  approvalsPending: Boolean,
  install: InstallState,
  gatewayFailed: Boolean,
  tailWaitingOnUser: Boolean,
  tailHermesBlank: Boolean
): AgentStatus = when {
  gatewayFailed || install == InstallState.FAILED -> AgentStatus.ERROR
  approvalsPending -> AgentStatus.WAITING
  streaming && (tailWaitingOnUser || tailHermesBlank) -> AgentStatus.THINKING
  streaming -> AgentStatus.EXECUTING
  install == InstallState.INSTALLING || install == InstallState.RUNNING && !connected ->
    AgentStatus.CONNECTING
  !connected -> AgentStatus.OFFLINE
  else -> AgentStatus.ONLINE
}

@Composable
private fun AgentStatusCard(
  status: AgentStatus,
  currentTask: String?,
  approvalsPending: Int,
  onOpenChat: () -> Unit
) {
  val color = statusColor(status)
  Card(
    colors = CardDefaults.cardColors(containerColor = HomeSurface),
    border = androidx.compose.foundation.BorderStroke(1.dp, color.copy(alpha = 0.45f)),
    modifier = Modifier.fillMaxWidth()
  ) {
    Column(Modifier.padding(14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(statusDot(status), color = color, fontSize = 22.sp,
          fontFamily = FontFamily.Monospace)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
          Text("AGENT ${status.name}", color = HomeText, fontSize = 18.sp,
            fontWeight = FontWeight.ExtraBold, fontFamily = FontFamily.Monospace)
          Text(
            when (status) {
              AgentStatus.ONLINE -> "Connected and ready"
              AgentStatus.THINKING -> "Reading context, planning a reply"
              AgentStatus.EXECUTING -> "Running tools, streaming output"
              AgentStatus.WAITING -> "$approvalsPending approval(s) need you"
              AgentStatus.OFFLINE -> "Gateway not connected"
              AgentStatus.CONNECTING -> "Gateway is starting…"
              AgentStatus.ERROR -> "Gateway failed, action needed"
            },
            color = HomeDim, fontSize = 12.sp, fontFamily = FontFamily.Monospace
          )
        }
        if (status == AgentStatus.WAITING || status == AgentStatus.EXECUTING ||
          status == AgentStatus.THINKING) {
          TextButton(onClick = onOpenChat) {
            Text("OPEN", color = NeonCyan, fontSize = 12.sp,
              fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
          }
        }
      }
      Spacer(Modifier.height(8.dp))
      Box(Modifier.fillMaxWidth().height(1.dp).background(HomeBorder))
      Spacer(Modifier.height(8.dp))
      Text("CURRENT TASK", color = HomeDim, fontSize = 10.sp,
        fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
      Spacer(Modifier.height(2.dp))
      Text(
        currentTask ?: "Nothing running",
        color = if (currentTask == null) HomeDim else HomeText,
        fontSize = 13.sp, fontFamily = FontFamily.Monospace,
        maxLines = 2, overflow = TextOverflow.Ellipsis
      )
    }
  }
}

@Composable
private fun ConnectionErrorCard(
  lastSeenMs: Long,
  reason: String?,
  onRetry: () -> Unit,
  onSettings: () -> Unit
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = HomeSurface),
    border = androidx.compose.foundation.BorderStroke(1.dp, NeonRed.copy(alpha = 0.5f)),
    modifier = Modifier.fillMaxWidth()
  ) {
    Column(Modifier.padding(14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.ErrorOutline, "connection failed", tint = NeonRed,
          modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Text("CONNECTION FAILED", color = NeonRed, fontSize = 14.sp,
          fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
      }
      Spacer(Modifier.height(6.dp))
      Text(
        "Last seen: " + if (lastSeenMs == 0L) "never connected" else homeAgo(lastSeenMs),
        color = HomeDim, fontSize = 12.sp, fontFamily = FontFamily.Monospace
      )
      if (!reason.isNullOrBlank()) {
        Spacer(Modifier.height(2.dp))
        Text(reason.take(300), color = HomeDim, fontSize = 12.sp,
          fontFamily = FontFamily.Monospace,
          maxLines = 3, overflow = TextOverflow.Ellipsis)
      }
      Spacer(Modifier.height(10.dp))
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
          onClick = onRetry,
          colors = ButtonDefaults.buttonColors(
            containerColor = NeonViolet, contentColor = Color.White),
          modifier = Modifier.weight(1f)
        ) {
          Icon(Icons.Filled.Refresh, "retry", modifier = Modifier.size(16.dp))
          Spacer(Modifier.width(4.dp))
          Text("Retry")
        }
        OutlinedButton(onClick = onSettings, modifier = Modifier.weight(1f)) {
          Icon(Icons.Filled.Settings, "connection settings",
            modifier = Modifier.size(16.dp))
          Spacer(Modifier.width(4.dp))
          Text("Connection Settings")
        }
      }
    }
  }
}

@Composable
private fun QuickAction(
  label: String,
  sub: String,
  icon: ImageVector,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier
) {
  Card(
    colors = CardDefaults.cardColors(
      containerColor = if (enabled) HomeSurface else HomeSurface.copy(alpha = 0.55f)),
    border = androidx.compose.foundation.BorderStroke(
      1.dp, (if (enabled) NeonViolet else HomeBorder).copy(alpha = 0.4f)),
    modifier = modifier.then(
      if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
  ) {
    Column(
      Modifier.padding(vertical = 12.dp, horizontal = 6.dp).fillMaxWidth(),
      horizontalAlignment = Alignment.CenterHorizontally
    ) {
      Icon(icon, label,
        tint = if (enabled) NeonCyan else HomeDim,
        modifier = Modifier.size(22.dp))
      Spacer(Modifier.height(6.dp))
      Text(label, color = if (enabled) HomeText else HomeDim, fontSize = 12.sp,
        fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
        maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(sub, color = HomeDim, fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

@Composable
private fun EmptyTasksCard(onStart: () -> Unit) {
  Card(
    colors = CardDefaults.cardColors(containerColor = HomeSurface),
    border = androidx.compose.foundation.BorderStroke(1.dp, HomeBorder),
    modifier = Modifier.fillMaxWidth()
  ) {
    Column(
      Modifier.padding(20.dp).fillMaxWidth(),
      horizontalAlignment = Alignment.CenterHorizontally
    ) {
      Icon(Icons.Filled.HourglassEmpty, "no active tasks", tint = HomeDim,
        modifier = Modifier.size(28.dp))
      Spacer(Modifier.height(8.dp))
      Text("NO ACTIVE TASKS", color = HomeText, fontSize = 14.sp,
        fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
      Spacer(Modifier.height(4.dp))
      Text("Hermes is idle", color = HomeDim, fontSize = 12.sp,
        fontFamily = FontFamily.Monospace)
      Spacer(Modifier.height(12.dp))
      Button(
        onClick = onStart,
        colors = ButtonDefaults.buttonColors(
          containerColor = NeonViolet, contentColor = Color.White)
      ) { Text("Start a Task") }
    }
  }
}

@Composable
private fun RecentSessionRow(
  title: String,
  meta: String,
  active: Boolean,
  onClick: () -> Unit
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = HomeSurface),
    border = androidx.compose.foundation.BorderStroke(
      1.dp, (if (active) NeonCyan else HomeBorder).copy(alpha = 0.5f)),
    modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)
  ) {
    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
      Icon(
        if (active) Icons.Filled.PlayArrow else Icons.Filled.ChatBubbleOutline,
        "session", tint = if (active) NeonCyan else HomeDim,
        modifier = Modifier.size(20.dp)
      )
      Spacer(Modifier.width(10.dp))
      Column(Modifier.weight(1f)) {
        Text(title, color = HomeText, fontSize = 13.sp,
          fontWeight = FontWeight.SemiBold,
          maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(meta, color = HomeDim, fontSize = 11.sp,
          fontFamily = FontFamily.Monospace,
          maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      if (active) {
        Spacer(Modifier.width(6.dp))
        Text("LIVE", color = NeonCyan, fontSize = 10.sp,
          fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
      }
    }
  }
}

@Composable
private fun RecentJobRow(
  name: String,
  meta: String,
  failed: Boolean,
  onClick: () -> Unit
) {
  Card(
    colors = CardDefaults.cardColors(containerColor = HomeSurface),
    border = androidx.compose.foundation.BorderStroke(
      1.dp, (if (failed) NeonRed else HomeBorder).copy(alpha = 0.5f)),
    modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)
  ) {
    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
      Icon(
        if (failed) Icons.Filled.ErrorOutline else Icons.Filled.CheckCircle,
        "job", tint = if (failed) NeonRed else NeonGreen,
        modifier = Modifier.size(20.dp)
      )
      Spacer(Modifier.width(10.dp))
      Column(Modifier.weight(1f)) {
        Text(name, color = HomeText, fontSize = 13.sp,
          fontWeight = FontWeight.SemiBold,
          maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(meta, color = HomeDim, fontSize = 11.sp,
          fontFamily = FontFamily.Monospace,
          maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}
