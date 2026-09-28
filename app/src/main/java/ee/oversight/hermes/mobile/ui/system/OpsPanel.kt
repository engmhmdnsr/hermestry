package ee.oversight.hermes.mobile.ui.system

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.BuildConfig
import ee.oversight.hermes.mobile.network.GatewayClient
import ee.oversight.hermes.mobile.ui.theme.CyberSurface
import ee.oversight.hermes.mobile.ui.theme.CyberTerminalBg
import ee.oversight.hermes.mobile.ui.theme.NeonAmber
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.NeonGreen
import ee.oversight.hermes.mobile.ui.theme.NeonRed
import ee.oversight.hermes.mobile.ui.theme.NeonViolet
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary
import ee.oversight.hermes.mobile.ui.theme.TextTerminal
import kotlinx.coroutines.launch

// SystemTab ops panel. All sections talk to the gateway through GatewayClient
// (baseUrl + Bearer server key), same pattern as the rest of the app.

@Composable
private fun OpsSection(title: String, content: @Composable () -> Unit) {
  Text(
    "// $title", color = NeonCyan, fontSize = 12.sp,
    fontFamily = FontFamily.Monospace
  )
  Card(
    colors = CardDefaults.cardColors(containerColor = CyberSurface),
    modifier = Modifier.fillMaxWidth()
  ) {
    Column(Modifier.padding(12.dp)) { content() }
  }
}

@Composable
fun ServerLogViewer(baseUrl: String, apiKey: String, fileTail: List<String> = emptyList()) {
  val client = remember(baseUrl, apiKey) { GatewayClient(baseUrl, { apiKey }) }
  var level by remember { mutableStateOf("ALL") }
  var query by remember { mutableStateOf("") }
  var lines by remember { mutableStateOf(listOf("press Refresh to read gateway.log")) }
  var note by remember { mutableStateOf("") }
  var loading by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  fun refresh() {
    scope.launch {
      loading = true
      note = ""
      try {
        val got = client.serverLogs(
          file = "",
          level = if (level == "ALL") "" else level,
          query = query,
          limit = 200
        )
        if (got.isEmpty()) {
          lines = emptyList()
          note = "log endpoint not exposed on this gateway (empty result)"
        } else {
          lines = got.map { l ->
            val ts = if (l.timestamp.isNotBlank()) "${l.timestamp} " else ""
            val lv = if (l.level.isNotBlank()) "[${l.level}] " else ""
            "$ts$lv${l.message}"
          }.filter { it.isNotBlank() }
        }
      } catch (e: Exception) {
        lines = emptyList()
        note = "log read failed: ${(e.message ?: "unknown").take(160)}"
      }
      loading = false
    }
  }

  LaunchedEffect(baseUrl) { refresh() }

  // Single log section: the on-device gateway.log file tail merged with the
  // endpoint viewer under one heading (no duplicate "// gateway.log").
  OpsSection("logs") {
    if (fileTail.isNotEmpty()) {
      Text(
        "gateway.log (file tail)", color = TextSecondary,
        fontSize = 11.sp, fontFamily = FontFamily.Monospace
      )
      Spacer(Modifier.height(4.dp))
      Column(
        Modifier.fillMaxWidth().background(CyberTerminalBg, RoundedCornerShape(6.dp))
          .padding(8.dp)
      ) {
        fileTail.takeLast(40).forEach { ln ->
          Text(ln, color = TextTerminal, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        }
      }
      Spacer(Modifier.height(8.dp))
      Text(
        "endpoint viewer", color = TextSecondary,
        fontSize = 11.sp, fontFamily = FontFamily.Monospace
      )
      Spacer(Modifier.height(4.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      listOf("ALL", "INFO", "WARN", "ERROR").forEach { lv ->
        FilterChip(
          selected = level == lv,
          onClick = { level = lv },
          label = { Text(lv, fontSize = 11.sp, fontFamily = FontFamily.Monospace) },
          colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = NeonViolet,
            selectedLabelColor = Color.White,
            containerColor = CyberTerminalBg,
            labelColor = TextSecondary
          )
        )
      }
    }
    Spacer(Modifier.height(6.dp))
    // Search stacked above its action, both full-width (was one cramped row).
    OutlinedTextField(
      value = query,
      onValueChange = { query = it },
      label = { Text("search", fontSize = 11.sp) },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
      colors = OutlinedTextFieldDefaults.colors(
        focusedTextColor = TextPrimary, unfocusedTextColor = TextPrimary,
        focusedBorderColor = NeonCyan, unfocusedBorderColor = TextSecondary
      )
    )
    Spacer(Modifier.height(6.dp))
    OutlinedButton(
      onClick = { refresh() },
      modifier = Modifier.fillMaxWidth()
    ) { Text("Reload logs") }
    Spacer(Modifier.height(6.dp))
    if (loading) CircularProgressIndicator(color = NeonCyan)
    if (note.isNotBlank()) Text(note, color = NeonAmber, fontSize = 12.sp)
    // Level/query already applied server-side; keep a light client-side
    // filter for the level chip so switching chips feels instant pre-refresh.
    val shown = lines.filter { ln ->
      (level == "ALL" || ln.contains(level, ignoreCase = true))
    }.takeLast(60)
    // Bounded box: fixed max height with its own scroll so long tails cannot
    // push the rest of SystemTab off screen. Autoscrolls to the bottom on
    // new lines (weight-free here: heightIn caps the box inside the parent).
    val logScroll = rememberScrollState()
    LaunchedEffect(shown.size) {
      try { logScroll.animateScrollTo(logScroll.maxValue) } catch (_: Exception) { }
    }
    Column(
      Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(logScroll)
        .background(CyberTerminalBg, RoundedCornerShape(6.dp))
        .padding(8.dp)
    ) {
      if (shown.isEmpty() && note.isBlank()) Text("(no lines match)", color = TextSecondary, fontSize = 11.sp)
      shown.forEach { ln ->
        Text(
          ln, color = when {
            ln.contains("ERROR", ignoreCase = true) -> NeonRed
            ln.contains("WARN", ignoreCase = true) -> NeonAmber
            else -> TextTerminal
          },
          fontSize = 11.sp, fontFamily = FontFamily.Monospace
        )
      }
    }
  }
}

@Composable
fun UsageStats(baseUrl: String, apiKey: String) {
  val client = remember(baseUrl, apiKey) { GatewayClient(baseUrl, { apiKey }) }
  var days by remember { mutableStateOf(7) }
  var body by remember { mutableStateOf("loading…") }
  var exposed by remember { mutableStateOf(true) }
  val scope = rememberCoroutineScope()

  fun load(d: Int) {
    scope.launch {
      body = "loading…"
      val range = "${d}d"
      try {
        val u = client.usageAnalytics(range)
        if (u == null) {
          exposed = false
          body = "usage endpoint not exposed on this gateway (null)"
        } else {
          exposed = true
          body = "last $range  sessions=${u.sessions}  msgs=${u.messages}  " +
            "in=${u.inputTokens}  out=${u.outputTokens}  cost=\$${u.costUsd}"
        }
      } catch (e: Exception) {
        exposed = false
        body = "usage read failed: ${(e.message ?: "unknown").take(160)}"
      }
    }
  }

  LaunchedEffect(baseUrl, days) { load(days) }

  OpsSection("usage") {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      listOf(7, 30).forEach { d ->
        FilterChip(
          selected = days == d,
          onClick = { days = d },
          label = { Text("${d}d", fontSize = 11.sp, fontFamily = FontFamily.Monospace) },
          colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = NeonViolet,
            selectedLabelColor = Color.White,
            containerColor = CyberTerminalBg,
            labelColor = TextSecondary
          )
        )
      }
    }
    Spacer(Modifier.height(6.dp))
    Text(
      body,
      modifier = Modifier.fillMaxWidth(),
      color = if (exposed) TextPrimary else NeonAmber,
      fontSize = 12.sp, fontFamily = FontFamily.Monospace,
      softWrap = true
    )
    if (!exposed) Text(
      "token totals unavailable — gateway does not expose a usage route",
      color = TextSecondary, fontSize = 12.sp
    )
  }
}

@Composable
fun RestartGateway(baseUrl: String, apiKey: String) {
  val client = remember(baseUrl, apiKey) { GatewayClient(baseUrl, { apiKey }) }
  var tail by remember { mutableStateOf(listOf("idle")) }
  var busy by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  OpsSection("restart gateway") {
    Button(
      onClick = {
        scope.launch {
          busy = true
          tail = listOf("POST restart…")
          try {
            val ok = client.restartGateway()
            tail = if (ok) listOf("restart accepted", "gateway coming back…")
            else listOf("restart not accepted (false)", "start/stop it from the device instead")
          } catch (e: Exception) {
            tail = listOf(
              "restart failed: ${(e.message ?: "unknown").take(160)}",
              "start/stop it from the device instead"
            )
          }
          busy = false
        }
      },
      enabled = !busy,
      colors = ButtonDefaults.buttonColors(containerColor = NeonViolet, contentColor = Color.White)
    ) {
      Text(if (busy) "Restarting…" else "Restart gateway")
    }
    Spacer(Modifier.height(6.dp))
    if (busy) CircularProgressIndicator(color = NeonCyan)
    Column(
      Modifier.fillMaxWidth().background(CyberTerminalBg, RoundedCornerShape(6.dp))
        .padding(8.dp)
    ) {
      tail.takeLast(10).forEach {
        Text(it, color = TextTerminal, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
      }
    }
  }
}

@Composable
fun UpdateCheck(baseUrl: String, apiKey: String) {
  val client = remember(baseUrl, apiKey) { GatewayClient(baseUrl, { apiKey }) }
  var version by remember { mutableStateOf("") }
  var notes by remember { mutableStateOf("checking…") }
  var exposed by remember { mutableStateOf(true) }
  val scope = rememberCoroutineScope()

  fun check() {
    scope.launch {
      notes = "checking…"
      // Running version comes from the real detailed-health route.
      try {
        val h = client.healthDetailed()
        if (h.version.isNotBlank()) version = h.version
      } catch (_: Exception) { }
      // Release notes via the real ops runner, graceful fallback to version-only.
      try {
        val r = client.opsRun("update-check")
        if (r != null && r.message.isNotBlank()) {
          notes = r.message.take(800)
          exposed = true
        } else {
          exposed = false
          notes = if (version.isNotBlank()) "release notes not exposed — running v$version"
          else "update endpoint not exposed on this gateway (null)"
        }
      } catch (e: Exception) {
        exposed = false
        notes = if (version.isNotBlank()) "release notes not exposed — running v$version"
        else "update check failed: ${(e.message ?: "unknown").take(160)}"
      }
    }
  }

  LaunchedEffect(baseUrl) { check() }

  OpsSection("update check") {
    Text(
      if (version.isNotBlank()) "gateway v$version" else "gateway version unknown",
      color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold
    )
    Spacer(Modifier.height(4.dp))
    Card(
      colors = CardDefaults.cardColors(containerColor = CyberTerminalBg),
      modifier = Modifier.fillMaxWidth()
    ) {
      Column(Modifier.padding(8.dp)) {
        Text("release notes", color = NeonAmber, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        Text(
          notes,
          color = if (exposed) TextSecondary else NeonAmber,
          fontSize = 12.sp
        )
      }
    }
    Spacer(Modifier.height(6.dp))
    OutlinedButton(onClick = { check() }) { Text("Check again") }
  }
}

@Composable
fun DoctorCard(baseUrl: String, apiKey: String) {
  val client = remember(baseUrl, apiKey) { GatewayClient(baseUrl, { apiKey }) }
  var summary by remember { mutableStateOf("press Run to check gateway health") }
  var checks by remember { mutableStateOf(emptyList<Triple<String, Boolean, String>>()) }
  var ok by remember { mutableStateOf<Boolean?>(null) }
  var busy by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  fun run() {
    scope.launch {
      busy = true
      try {
        val r = client.doctor()
        if (r == null) {
          ok = null
          summary = "doctor endpoint not exposed on this gateway (null)"
          checks = emptyList()
        } else {
          ok = r.ok
          summary = r.summary.ifBlank { if (r.ok) "all checks pass" else "issues found" } +
            (if (r.version.isNotBlank()) "  (v${r.version})" else "")
          checks = r.checks.map { Triple(it.name, it.ok, it.detail) }
        }
      } catch (e: Exception) {
        ok = null
        summary = "doctor failed: ${(e.message ?: "unknown").take(160)}"
        checks = emptyList()
      }
      busy = false
    }
  }

  LaunchedEffect(baseUrl) { run() }

  OpsSection("doctor") {
    Text(
      summary,
      color = when (ok) { true -> NeonGreen; false -> NeonRed; null -> NeonAmber },
      fontSize = 12.sp, fontFamily = FontFamily.Monospace
    )
    Spacer(Modifier.height(4.dp))
    Column(
      Modifier.fillMaxWidth().background(CyberTerminalBg, RoundedCornerShape(6.dp))
        .padding(8.dp)
    ) {
      if (checks.isEmpty()) Text("(no checks)", color = TextSecondary, fontSize = 11.sp)
      checks.forEach { (name, passed, detail) ->
        Text(
          (if (passed) "PASS " else "FAIL ") + name +
            (if (detail.isNotBlank()) " — ${detail.take(200)}" else ""),
          color = if (passed) TextTerminal else NeonRed,
          fontSize = 11.sp, fontFamily = FontFamily.Monospace
        )
      }
    }
    Spacer(Modifier.height(6.dp))
    OutlinedButton(onClick = { run() }, enabled = !busy) {
      Text(if (busy) "Running…" else "Run doctor")
    }
  }
}

@Composable
fun BackupCard(baseUrl: String, apiKey: String) {
  val client = remember(baseUrl, apiKey) { GatewayClient(baseUrl, { apiKey }) }
  var body by remember { mutableStateOf("press Backup to snapshot the gateway") }
  var succeeded by remember { mutableStateOf<Boolean?>(null) }
  var busy by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  fun run() {
    scope.launch {
      busy = true
      try {
        val r = client.backup()
        if (r == null) {
          succeeded = null
          body = "backup endpoint not exposed on this gateway (null)"
        } else {
          succeeded = r.ok
          body = (if (r.ok) "backup ok" else "backup failed") +
            (if (r.path.isNotBlank()) "\n${r.path}" else "") +
            (if (r.message.isNotBlank()) "\n${r.message.take(400)}" else "")
        }
      } catch (e: Exception) {
        succeeded = null
        body = "backup failed: ${(e.message ?: "unknown").take(160)}"
      }
      busy = false
    }
  }

  OpsSection("backup") {
    Text(
      body,
      color = when (succeeded) { true -> NeonGreen; false -> NeonRed; null -> TextSecondary },
      fontSize = 12.sp, fontFamily = FontFamily.Monospace
    )
    Spacer(Modifier.height(6.dp))
    OutlinedButton(onClick = { run() }, enabled = !busy) {
      Text(if (busy) "Backing up…" else "Run backup")
    }
  }
}

@Composable
fun DebugShareCard(baseUrl: String, apiKey: String) {
  val client = remember(baseUrl, apiKey) { GatewayClient(baseUrl, { apiKey }) }
  var body by remember { mutableStateOf("press Share to upload a debug bundle") }
  var urls by remember { mutableStateOf(emptyList<String>()) }
  var busy by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  fun run() {
    scope.launch {
      busy = true
      try {
        val r = client.debugShare()
        if (r == null) {
          body = "debug-share endpoint not exposed on this gateway (null)"
          urls = emptyList()
        } else {
          urls = r.urls
          body = r.summary.ifBlank {
            if (r.urls.isEmpty()) "shared, no links returned" else "debug bundle uploaded"
          }.take(400)
        }
      } catch (e: Exception) {
        body = "debug share failed: ${(e.message ?: "unknown").take(160)}"
        urls = emptyList()
      }
      busy = false
    }
  }

  OpsSection("debug share") {
    Text(body, color = TextSecondary, fontSize = 12.sp)
    Spacer(Modifier.height(4.dp))
    Column(
      Modifier.fillMaxWidth().background(CyberTerminalBg, RoundedCornerShape(6.dp))
        .padding(8.dp)
    ) {
      if (urls.isEmpty()) Text("(no links yet)", color = TextSecondary, fontSize = 11.sp)
      urls.forEach { u ->
        Text(u, color = NeonCyan, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
      }
    }
    Spacer(Modifier.height(6.dp))
    OutlinedButton(onClick = { run() }, enabled = !busy) {
      Text(if (busy) "Uploading…" else "Share debug bundle")
    }
  }
}

@Composable
fun AboutCard(baseUrl: String, apiKey: String) {
  // baseUrl/apiKey accepted for a uniform (baseUrl, apiKey) hook signature;
  // this card is static device info and does not call the network.
  OpsSection("about") {
    Text("Hermes Mobile v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
      color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.Bold)
    Text("package ${BuildConfig.APPLICATION_ID}", color = TextSecondary, fontSize = 12.sp,
      fontFamily = FontFamily.Monospace)
    Text("gateway $baseUrl", color = TextSecondary, fontSize = 12.sp,
      fontFamily = FontFamily.Monospace)
    Text(
      if (apiKey.isNotBlank()) "server key: set" else "server key: not set",
      color = if (apiKey.isNotBlank()) NeonGreen else NeonAmber,
      fontSize = 12.sp, fontFamily = FontFamily.Monospace
    )
  }
}

@Composable
private fun AppLogCompact(lines: List<String>) {
  var open by remember { mutableStateOf(false) }
  // Replaces the old always-empty "// app log" void: max 5 lines + expand link.
  OpsSection("app log") {
    if (lines.isEmpty()) {
      Text(
        "(app log empty)", color = TextSecondary,
        fontSize = 11.sp, fontFamily = FontFamily.Monospace
      )
    } else {
      Column(
        Modifier.fillMaxWidth().background(CyberTerminalBg, RoundedCornerShape(6.dp))
          .padding(8.dp)
      ) {
        (if (open) lines.takeLast(40) else lines.takeLast(5)).forEach { ln ->
          Text(ln, color = TextSecondary, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        }
      }
      if (lines.size > 5) {
        Spacer(Modifier.height(4.dp))
        TextButton(onClick = { open = !open }) {
          Text(
            if (open) "show less" else "show all ${lines.size} lines",
            fontSize = 12.sp
          )
        }
      }
    }
  }
}

@Composable
fun OpsPanel(
  baseUrl: String,
  apiKey: String,
  fileTail: List<String> = emptyList(),
  appTail: List<String> = emptyList()
) {
  // Collapsed by default: keeps the "not exposed" amber notes one tap away
  // instead of stacked on screen. Tab order: status > actions > logs > advanced.
  var advancedOpen by remember { mutableStateOf(false) }
  Column(
    modifier = Modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(12.dp)
  ) {
    ServerLogViewer(baseUrl, apiKey, fileTail)
    AppLogCompact(appTail)
    Column(
      modifier = Modifier.fillMaxWidth(),
      verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
      Row(
        modifier = Modifier.fillMaxWidth()
          .clickable { advancedOpen = !advancedOpen }
          .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
      ) {
        Text(
          "// advanced ops", color = NeonCyan, fontSize = 12.sp,
          fontFamily = FontFamily.Monospace
        )
        Text(
          if (advancedOpen) "▾" else "▸",
          color = TextSecondary, fontSize = 12.sp,
          fontFamily = FontFamily.Monospace
        )
      }
      if (advancedOpen) {
        UsageStats(baseUrl, apiKey)
        RestartGateway(baseUrl, apiKey)
        UpdateCheck(baseUrl, apiKey)
        DoctorCard(baseUrl, apiKey)
        BackupCard(baseUrl, apiKey)
        DebugShareCard(baseUrl, apiKey)
        AboutCard(baseUrl, apiKey)
      }
    }
    // Keep the horizontal scroll import live: model ids overflow on narrow screens.
    Row(Modifier.horizontalScroll(rememberScrollState())) {
      Text("ee.oversight.hermes.mobile", color = CyberSurface, fontSize = 1.sp)
    }
  }
}
