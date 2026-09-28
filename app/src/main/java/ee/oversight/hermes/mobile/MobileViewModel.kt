package ee.oversight.hermes.mobile

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import ee.oversight.hermes.mobile.install.Bootstrap
import ee.oversight.hermes.mobile.model.AiModelInfo
import ee.oversight.hermes.mobile.model.Blueprint
import ee.oversight.hermes.mobile.model.ChatMessage
import ee.oversight.hermes.mobile.model.CronJob
import ee.oversight.hermes.mobile.model.CronRun
import ee.oversight.hermes.mobile.model.GatewayStatus
import ee.oversight.hermes.mobile.model.MemoryInfo
import ee.oversight.hermes.mobile.model.MobileSession
import ee.oversight.hermes.mobile.model.PendingApproval
import ee.oversight.hermes.mobile.model.SkillInfo
import ee.oversight.hermes.mobile.network.GatewayClient
import ee.oversight.hermes.mobile.security.SecurePrefs
import ee.oversight.hermes.mobile.ui.sessions.SessionPinStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

enum class InstallState { NOT_INSTALLED, INSTALLING, INSTALLED, RUNNING, FAILED }

/** Per-turn display metadata for assistant bubbles: real model used + client-measured turn time. */
data class TurnMeta(val model: String = "", val durationMs: Long = 0L)

/** Follow-up typed while a turn streams: drained FIFO after the stream ends. */
data class QueuedMessage(val text: String, val images: List<String> = emptyList())

/** Draft handed back to the UI when send() fails before streaming (e.g. session
 * create failed): the typed text plus any attached images, so nothing is lost. */
data class FailedDraft(val text: String, val imageDataUrls: List<String> = emptyList())

class MobileViewModel(private val app: Context) : ViewModel() {
  private val prefs = app.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
  private val client = GatewayClient(apiKey = { serverKey() })

  private val _install = MutableStateFlow(
    if (Bootstrap.isInstalled(app)) InstallState.INSTALLED else InstallState.NOT_INSTALLED
  )
  val install: StateFlow<InstallState> = _install

  private val _progress = MutableStateFlow("")
  val progress: StateFlow<String> = _progress

  private val _installError = MutableStateFlow<String?>(null)
  val installError: StateFlow<String?> = _installError

  // Circuit-breaker mirror: set by MobileGatewayService.supervise() after
  // 5 consecutive failures; cleared on the next explicit Start.
  val gatewayFailed: StateFlow<Boolean> =
    ee.oversight.hermes.mobile.service.MobileGatewayService.gatewayFailed
  val gatewayFailureReason: StateFlow<String?> =
    ee.oversight.hermes.mobile.service.MobileGatewayService.gatewayFailureReason

  private val _log = MutableStateFlow<List<String>>(emptyList())
  val log: StateFlow<List<String>> = _log

  private val _connected = MutableStateFlow(false)
  val connected: StateFlow<Boolean> = _connected

  private val _status = MutableStateFlow(GatewayStatus(false))
  val status: StateFlow<GatewayStatus> = _status

  private val _sessions = MutableStateFlow<List<MobileSession>>(emptyList())
  val sessions: StateFlow<List<MobileSession>> = _sessions

  private val _currentSessionId = MutableStateFlow<String?>(null)
  val currentSessionId: StateFlow<String?> = _currentSessionId

  private val _bySession = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
  private val _chatMirror = MutableStateFlow<List<ChatMessage>>(emptyList())
  val chat: StateFlow<List<ChatMessage>> = _chatMirror

  private val _streaming = MutableStateFlow(false)
  val streaming: StateFlow<Boolean> = _streaming
  // Async send failure hands the typed text + images back to the UI input.
  private val _failedDraft = MutableStateFlow<FailedDraft?>(null)
  val failedDraft: StateFlow<FailedDraft?> = _failedDraft
  fun consumeFailedDraft() { _failedDraft.value = null }

  // Per-session attached-image drafts: DraftStore persists text only, so
  // ChatTab stashes attachedImages here on session switch and restores them
  // on return. Backed by the same prefs file (`imgdraft_<sessionId>`).
  private val _imageDrafts = MutableStateFlow<Map<String, List<String>>>(emptyMap())
  fun imageDraft(sid: String?): List<String> {
    val key = sid ?: "none"
    _imageDrafts.value[key]?.let { return it }
    val fromPrefs = try {
      prefs.getStringSet("imgdraft_$key", emptySet()).orEmpty().toList()
    } catch (_: Exception) { emptyList() }
    return fromPrefs.take(4)
  }
  fun stashImageDraft(sid: String?, images: List<String>) {
    val key = sid ?: "none"
    val kept = images.take(4)
    _imageDrafts.update { it + (key to kept) }
    try {
      prefs.edit().putStringSet("imgdraft_$key", kept.toSet()).apply()
    } catch (_: Exception) { }
  }

  // Follow-ups typed while streaming: drained FIFO (one at a time) in the send tail.
  private val _queuedMessages = MutableStateFlow<List<QueuedMessage>>(emptyList())
  val queuedMessages: StateFlow<List<QueuedMessage>> = _queuedMessages

  private val _models = MutableStateFlow<List<AiModelInfo>>(emptyList())
  val models: StateFlow<List<AiModelInfo>> = _models

  private val _jobs = MutableStateFlow<List<CronJob>>(emptyList())
  val jobs: StateFlow<List<CronJob>> = _jobs

  private val _approvals = MutableStateFlow<List<PendingApproval>>(emptyList())
  val approvals: StateFlow<List<PendingApproval>> = _approvals
  // Token usage from the live stream (Control-style pill in the top bar).
  private val _usageIn = MutableStateFlow(0L)
  val usageIn: StateFlow<Long> = _usageIn
  private val _usageOut = MutableStateFlow(0L)
  val usageOut: StateFlow<Long> = _usageOut
  private val handledApprovals = mutableSetOf<String>()

  private var streamJob: Job? = null
  private var pollJob: Job? = null
  // Turn token: each send() claim bumps this; the coroutine tail only
  // clears _streaming / drains the queue while it still owns the token.
  // Without it the cancelled turn's tail (sendNow path) cleared the new
  // turn's claim and a second stream could start concurrently.
  private val streamTurn = java.util.concurrent.atomic.AtomicInteger(0)
  // Active turn's server run_id (from the stream envelope) + per-message footer
  // metadata keyed by assistant message id. TurnMeta lives outside ChatMessage
  // so no model-layer change is needed for footer data.
  private var activeRunId: String? = null
  private val _turnMeta = MutableStateFlow<Map<String, TurnMeta>>(emptyMap())
  val turnMeta: StateFlow<Map<String, TurnMeta>> = _turnMeta

  /** Server run_id of the live turn (null when idle); backs stop/sendNow. */
  fun getActiveRunId(): String? = activeRunId

  // prefs
  // Secrets live in the encrypted store; everything else stays in cleartext.
  fun apiKey(): String = SecurePrefs.getString(app, SecurePrefs.KEY_PROVIDER)
  fun baseUrl(): String = prefs.getString("provider_base_url", "") ?: ""
  fun provider(): String = prefs.getString("provider_name", "deepseek") ?: "deepseek"
  fun modelId(): String = prefs.getString("model_id", "") ?: ""
  fun tgToken(): String = SecurePrefs.getString(app, SecurePrefs.KEY_TG)
  fun discordToken(): String = SecurePrefs.getString(app, SecurePrefs.KEY_DISCORD)
  fun serverKey(): String = SecurePrefs.getString(app, SecurePrefs.KEY_SERVER)
  // Default false: boot autostart needs explicit user consent (see
  // needAutostartConsent). Absent key also reads as false.
  fun autostart(): Boolean = prefs.getBoolean("autostart", false)
  fun hasAutostartChoice(): Boolean = prefs.contains("autostart")
  private val _needAutostartConsent = MutableStateFlow(!prefs.contains("autostart"))
  val needAutostartConsent: StateFlow<Boolean> = _needAutostartConsent
  fun setAutostart(v: Boolean) {
    prefs.edit().putBoolean("autostart", v).apply()
    _needAutostartConsent.value = false
  }
  fun isOnboarded(): Boolean = prefs.getBoolean("onboarded", false)
  fun setOnboarded() { prefs.edit().putBoolean("onboarded", true).apply() }

  init {
    // Warm the encrypted store off the main thread so the first secret
    // read (and any cleartext migration) avoids Keystore work on the UI thread.
    viewModelScope.launch(Dispatchers.IO) {
      try { SecurePrefs.prefs(app) } catch (_: Exception) { }
    }
  }

  fun saveKeys(
    provider: String, key: String, model: String, baseUrl: String,
    tg: String, discord: String, serverKey: String, autostart: Boolean
  ) {
    // Pasted secrets with interior newlines would break YAML quoting;
    // API keys/tokens never legitimately contain them.
    fun clean(s: String) = s.trim().replace("\n", "").replace("\r", "")
    prefs.edit()
      .putString("provider_name", normProvider(clean(provider)).ifBlank { "deepseek" })
      .putString("provider_base_url", clean(baseUrl))
      .putString("model_id", clean(model))
      .putBoolean("autostart", autostart)
      .apply()
    SecurePrefs.putString(app, SecurePrefs.KEY_PROVIDER, clean(key))
    SecurePrefs.putString(app, SecurePrefs.KEY_TG, clean(tg))
    SecurePrefs.putString(app, SecurePrefs.KEY_DISCORD, clean(discord))
    SecurePrefs.putString(app, SecurePrefs.KEY_SERVER, clean(serverKey))
    _needAutostartConsent.value = false
    addLog("settings saved")
  }

  fun addLog(s: String) {
    _log.value = (_log.value + s).takeLast(400)
  }

  /** Screen-visible log writer (buttons use this; install uses addLog). */
  fun addLogPublic(s: String) = addLog(s)

  // install / start / stop
  fun install() {
    if (_install.value == InstallState.INSTALLING) return
    _install.value = InstallState.INSTALLING
    _installError.value = null
    viewModelScope.launch {
      try {
        Bootstrap.install(app) { _progress.value = it; addLog(it) }
        _install.value = InstallState.INSTALLED
        _installError.value = null
        addLog("installed OK, press Start")
      } catch (e: Exception) {
        _installError.value = e.message
        addLog("install FAILED: ${e.message}")
        _install.value = InstallState.FAILED
      }
    }
  }

  /** Saves install diagnostics to Download; returns the message for the log. */
  fun exportLog(): String {
    return try {
      Bootstrap.exportInstallLog(app)
    } catch (e: Exception) {
      "export failed: ${e.message}"
    }
  }

  fun start() {
    try { Bootstrap.renderConfig(app) } catch (_: Exception) { }
    ee.oversight.hermes.mobile.service.MobileGatewayService.start(app)
    _install.value = InstallState.RUNNING
    addLog("gateway starting on localhost:8080...")
    startPolling()
  }

  // Explicit-stop guard: the service socket can stay alive briefly after
  // stop(), so a health check racing the shutdown would re-mark the gateway
  // RUNNING via coldStart(). Skip coldStart shortly after a user Stop.
  private var lastUserStopMs = 0L

  fun stop() {
    lastUserStopMs = System.currentTimeMillis()
    stopPolling()
    stopStream()
    ee.oversight.hermes.mobile.service.MobileGatewayService.stop(app)
    _install.value = if (Bootstrap.isInstalled(app)) InstallState.INSTALLED else InstallState.NOT_INSTALLED
    _connected.value = false
    addLog("gateway stopped")
  }

  // polling: health + sessions + approvals (immediate check, then 15s cadence)
  private fun startPolling() {
    if (pollJob != null) return
    pollJob = viewModelScope.launch {
      pollOnce()
      while (true) {
        delay(15_000)
        pollOnce()
      }
    }
  }

  private suspend fun pollOnce() {
    val ok = client.health()
    _connected.value = ok
    if (ok) {
      _status.value = client.healthDetailed()
      refreshSessions()
      refreshApprovals()
      if (_models.value.isEmpty()) {
        val ms = client.modelOptions()
        if (ms.isNotEmpty()) _models.value = ms
      }
    }
  }

  private fun stopPolling() {
    pollJob?.cancel()
    pollJob = null
  }

  suspend fun refreshNow() {
    val ok = client.health()
    _connected.value = ok
    if (ok) {
      _status.value = client.healthDetailed()
      refreshSessions()
      refreshApprovals()
      val ms = client.modelOptions()
      if (ms.isNotEmpty()) _models.value = ms
      refreshJobs()
    }
  }

  // GatewayClient.sessions() exposes no success flag: transport failures
  // surface as an empty list, identical to a genuinely empty server. Callers
  // only reach here after a passing health check, so empty is treated as
  // genuine server-empty and the UI list is cleared (no ghost sessions).
  // A failed fetch right after a passing health check is rare and the next
  // 15s poll repopulates.
  private suspend fun refreshSessions() {
    val (list, _) = client.sessions(100, 0)
    _sessions.value = list.sortedByDescending { it.lastActiveAt }
    // Pins for sessions the server no longer lists must not linger.
    try {
      SessionPinStore.prune(app, _sessions.value.map { it.id }.toSet())
    } catch (_: Exception) { }
  }

  private suspend fun refreshApprovals() {
    val all = client.pendingApprovals().filter { it.runId !in handledApprovals }
    _approvals.value = all
    // Global auto-approve (Setup toggle): resolve as session-allow without asking.
    if (ee.oversight.hermes.mobile.ui.chat.AutoApproveState.global) {
      for (a in all) resolveApproval(a, true, "session")
    }
  }

  /** Cold start (e.g. after boot-autostart): gateway may already run, reattach. */
  fun coldStart() {
    if (_install.value != InstallState.INSTALLED) return
    if (System.currentTimeMillis() - lastUserStopMs < 30_000) return
    viewModelScope.launch {
      val ok = try { client.health() } catch (_: Exception) { false }
      _connected.value = ok
      if (ok) {
        _install.value = InstallState.RUNNING
        startPolling()
        refreshNow()
      }
    }
  }

  override fun onCleared() {
    stopPolling()
    streamJob?.cancel()
    super.onCleared()
  }

  // sessions
  fun newSession() {
    viewModelScope.launch {
      val model = modelId().ifBlank { _models.value.firstOrNull()?.id.orEmpty() }
      val id = client.createSession(model)
      if (id == null) { addLog("create session failed, is the gateway running?"); return@launch }
      refreshSessions()
      selectSession(id)
    }
  }

  fun selectSession(id: String) {
    _currentSessionId.value = id
    _chatMirror.value = _bySession.value[id].orEmpty()
    viewModelScope.launch {
      val cached = _bySession.value[id]
      if (!cached.isNullOrEmpty()) return@launch
      val msgs = client.sessionMessages(id).map {
        ChatMessage(UUID.randomUUID().toString(), it.first, it.second)
      }
      updateSessionMessages(id) { msgs }
    }
  }

  fun deleteSession(id: String) {
    viewModelScope.launch {
      if (client.deleteSession(id)) {
        _bySession.update { it - id }
        _sessions.update { l -> l.filter { s -> s.id != id } }
        try {
          SessionPinStore.prune(app, _sessions.value.map { it.id }.toSet())
        } catch (_: Exception) { }
        if (_currentSessionId.value == id) {
          _currentSessionId.value = null
          _chatMirror.value = emptyList()
        }
      } else addLog("delete failed")
    }
  }

  fun renameSession(id: String, title: String) {
    viewModelScope.launch {
      if (title.isBlank()) return@launch
      if (client.renameSession(id, title)) {
        _sessions.update { l -> l.map { if (it.id == id) it.copy(title = title) else it } }
      } else addLog("rename failed")
    }
  }

  fun forkSession(id: String) {
    viewModelScope.launch {
      val nid = client.forkSession(id)
      if (nid == null) { addLog("fork failed"); return@launch }
      refreshSessions()
      selectSession(nid)
    }
  }

  private fun updateSessionMessages(sid: String, fn: (List<ChatMessage>) -> List<ChatMessage>) {
    _bySession.update { m -> m + (sid to fn(m[sid].orEmpty())) }
    if (_currentSessionId.value == sid) _chatMirror.value = _bySession.value[sid].orEmpty()
  }

  // send with capture-at-send session id. Returns false when the send is a
  // no-op (blank text or already streaming) so the UI keeps the draft.
  // imageDataUrls: data:image/... URLs sent as vision parts (no upload needed).
  fun send(text: String, imageDataUrls: List<String> = emptyList()): Boolean {
    val t = text.trim()
    if ((t.isEmpty() && imageDataUrls.isEmpty()) || _streaming.value) return false
    // Claim the guard synchronously: _streaming was set inside the coroutine
    // after network I/O, so two rapid taps both passed and the first stream
    // leaked (overwritten streamJob = unstoppable). finally clears this.
    _streaming.value = true
    val myTurn = streamTurn.incrementAndGet()
    var sid = _currentSessionId.value
    var turnMsgId: String? = null
    var turnStartMs = 0L
    streamJob = viewModelScope.launch {
      try {
        if (sid == null) {
          val model = modelId().ifBlank { _models.value.firstOrNull()?.id.orEmpty() }
          sid = client.createSession(model)
          if (sid == null) {
            addLog("send failed: no session (gateway running?), draft preserved")
            _failedDraft.value = FailedDraft(t, imageDataUrls)
            return@launch
          }
          _currentSessionId.value = sid
          _chatMirror.value = emptyList()
          refreshSessions()
        }
        val streamSid = sid!!
        val model = modelId().ifBlank { _models.value.firstOrNull()?.id.orEmpty() }
        val effort = prefs.getString("pref_reasoning_effort", "medium") ?: "medium"
        val userMsg = ChatMessage(UUID.randomUUID().toString(), "you", t)
        val agentMsgId = UUID.randomUUID().toString()
        updateSessionMessages(streamSid) { it + userMsg }
        updateSessionMessages(streamSid) { it + ChatMessage(agentMsgId, "hermes", "", thinkingDone = false) }
        _turnMeta.update { it + (agentMsgId to TurnMeta(model = model)) }
        activeRunId = null
        turnMsgId = agentMsgId
        turnStartMs = System.currentTimeMillis()
        var attempt = 0
        var gotContent = false
        while (attempt < 2 && !gotContent) {
          attempt++
          val r = client.streamChat(
            streamSid, model, t,
            reasoningEffort = effort,
            imageDataUrls = imageDataUrls,
            onRunId = { activeRunId = it },
            onText = { d ->
              gotContent = true
              updateSessionMessages(streamSid) { l ->
                l.map { if (it.id == agentMsgId) it.copy(content = it.content + d) else it }
              }
            },
            onThinking = { d ->
              gotContent = true
              updateSessionMessages(streamSid) { l ->
                l.map { if (it.id == agentMsgId) it.copy(thinking = it.thinking + d) else it }
              }
            },
            onTool = { name ->
              gotContent = true
              updateSessionMessages(streamSid) { l ->
                l.map { if (it.id == agentMsgId) it.copy(tools = it.tools + name) else it }
              }
            },
            onUsage = { i, o ->
              _usageIn.update { it + i }
              _usageOut.update { it + o }
            },
            onApproval = { req ->
              // Run parked mid-stream: surface it now (polling also picks it up).
              if (req.runId !in handledApprovals) {
                _approvals.update { l -> if (l.any { it.runId == req.runId }) l else l + req }
                addLog("approval needed: ${req.summary.take(120)}")
              }
            }
          )
          if (r.isFailure && !gotContent) {
            if (attempt >= 2) {
              val msg = client.friendlyError(r.exceptionOrNull() ?: RuntimeException("stream failed"))
              updateSessionMessages(streamSid) { l ->
                l.map { if (it.id == agentMsgId) it.copy(content = msg, thinkingDone = true) else it }
              }
            }
          } else break
        }
      } finally {
        // Also runs on cancel (stop button): never leave the bubble "thinking".
        // Client-measured turn duration feeds the MessageFooter (real data).
        val doneId = turnMsgId
        if (doneId != null) {
          val elapsed = System.currentTimeMillis() - turnStartMs
          _turnMeta.update { m ->
            val cur = m[doneId] ?: TurnMeta()
            m + (doneId to cur.copy(durationMs = elapsed))
          }
        }
        if (doneId != null && sid != null) markThinkingDone(doneId, sid!!)
        if (sid != null) {
          updateSessionMessages(sid!!) { l ->
            l.map { if (it.sender == "hermes" && !it.thinkingDone) it.copy(thinkingDone = true) else it }
          }
        }
        // Only the owning turn clears the guard and drains: a cancelled
        // turn's tail (sendNow path) must not clear the new turn's claim,
        // so drainQueue's own _streaming guard runs correctly.
        if (myTurn == streamTurn.get()) {
          _streaming.value = false
          drainQueue(sid)
        }
      }
      refreshSessions()
    }
    return true
  }

  // Chat queue: follow-ups typed while a turn streams. Plain send() still
  // refuses while streaming (callers decide: queueMessage vs sendNow).
  fun queueMessage(text: String, imageDataUrls: List<String> = emptyList()): Boolean {
    val t = text.trim()
    if (t.isEmpty() && imageDataUrls.isEmpty()) return false
    _queuedMessages.update { it + QueuedMessage(t, imageDataUrls) }
    return true
  }

  fun cancelQueued() { _queuedMessages.value = emptyList() }

  // Explicit per-message thinking-done setter (stream-done path calls this
  // for the turn message; the tail sweep below stays as the backstop).
  fun markThinkingDone(messageId: String, sessionId: String) {
    updateSessionMessages(sessionId) { l ->
      l.map { if (it.id == messageId && !it.thinkingDone) it.copy(thinkingDone = true) else it }
    }
  }

  // Interrupt + immediate send: stops the live turn server-side (via
  // stopStream, which also cancels the local SSE read) then sends normally.
  fun sendNow(text: String, imageDataUrls: List<String> = emptyList()): Boolean {
    val t = text.trim()
    if (t.isEmpty() && imageDataUrls.isEmpty()) return false
    stopStream()
    return send(text, imageDataUrls)
  }

  // FIFO drain: same session only, one message per stream end (the new send's
  // own tail drains the next). Skips when a new turn already claimed the guard
  // (sendNow path: the cancelled turn's tail runs after the new send started);
  // on refusal the head is re-queued at the front so nothing is lost.
  private fun drainQueue(finishedSid: String?) {
    if (_streaming.value) return
    if (finishedSid == null || finishedSid != _currentSessionId.value) return
    val next = _queuedMessages.value.firstOrNull() ?: return
    _queuedMessages.update { it.drop(1) }
    if (!send(next.text, next.images)) {
      _queuedMessages.update { listOf(next) + it }
    }
  }

  // Stop: cancel the local SSE read AND stop the server-side run when its
  // run_id is already known (POST /v1/runs/{id}/stop — the HTTP equivalent of
  // Desktop's `session.interrupt`, which has no HTTP route). Local cancel is
  // synchronous so the UI flips instantly; the server stop fires async.
  fun stopStream() {
    val wasStreaming = _streaming.value
    streamJob?.cancel()
    streamJob = null
    _streaming.value = false
    val rid = activeRunId
    activeRunId = null
    // Only chase the server when a turn was actually live; otherwise the
    // stored id belongs to an already-finished run (completed turns clear
    // nothing — the next send() resets it).
    if (wasStreaming && !rid.isNullOrBlank()) {
      viewModelScope.launch {
        if (!client.stopRun(rid)) addLog("server stop failed, stream cancelled locally")
      }
    }
  }

  // jobs
  fun refreshJobs() {
    viewModelScope.launch {
      val list = client.jobs()
      _jobs.value = list
    }
  }

  fun createJob(name: String, schedule: String, prompt: String) {
    if (name.isBlank() || schedule.isBlank() || prompt.isBlank()) {
      addLog("create job rejected: name, schedule and prompt are all required")
      return
    }
    viewModelScope.launch {
      if (client.createJob(name, schedule, prompt)) refreshJobs()
      else addLog("create job failed")
    }
  }

  fun jobAction(id: String, action: String) {
    viewModelScope.launch {
      if (client.jobAction(id, action)) refreshJobs()
      else addLog("job $action failed")
    }
  }

  // approvals
  fun resolveApproval(a: PendingApproval, allow: Boolean, mode: String = "once") {
    viewModelScope.launch {
      if (client.resolveApproval(a.runId, allow, mode)) {
        handledApprovals += a.runId
        _approvals.update { l -> l.filter { it.runId != a.runId } }
      } else addLog("approval call failed")
    }
  }

  fun serviceLogTail(): List<String> {
    return try {
      val f = java.io.File(Bootstrap.rootDir(app), "gateway.log")
      if (!f.exists()) return listOf("no gateway.log yet, press Start")
      val bytes = f.readBytes()
      val tail = if (bytes.size > 8000) bytes.copyOfRange(bytes.size - 8000, bytes.size) else bytes
      tail.toString(Charsets.UTF_8).lines().takeLast(60)
    } catch (e: Exception) {
      listOf("log read failed: ${e.message}")
    }
  }

  // ── MoreTab passthroughs (skills / memory / blueprints / run history) ──
  // client is private, so these thin helpers are the only wiring path.
  private val _skills = MutableStateFlow<List<SkillInfo>>(emptyList())
  val skills: StateFlow<List<SkillInfo>> = _skills

  fun refreshSkills() {
    viewModelScope.launch { _skills.value = client.skillsList() }
  }

  fun toggleSkill(id: String, on: Boolean) {
    viewModelScope.launch {
      if (client.skillToggle(id, on)) refreshSkills()
      else addLog("skill toggle failed")
    }
  }

  private val _memory = MutableStateFlow<MemoryInfo?>(null)
  val memory: StateFlow<MemoryInfo?> = _memory

  fun refreshMemory() {
    viewModelScope.launch { _memory.value = client.memoryGet() }
  }

  /** No memory-reset route exists on the gateway client — logs, does not fake. */
  fun resetMemory() {
    addLog("memory reset not supported by gateway")
  }

  private val _blueprints = MutableStateFlow<List<Blueprint>>(emptyList())
  val blueprints: StateFlow<List<Blueprint>> = _blueprints

  fun refreshBlueprints() {
    viewModelScope.launch { _blueprints.value = client.blueprints() }
  }

  fun instantiateBlueprint(id: String, slots: Map<String, String>) {
    viewModelScope.launch {
      if (!client.instantiateBlueprint(id, slots)) addLog("blueprint instantiate failed")
      else addLog("blueprint $id instantiated")
    }
  }

  private val _runs = MutableStateFlow<Map<String, List<CronRun>>>(emptyMap())
  val runs: StateFlow<Map<String, List<CronRun>>> = _runs

  fun refreshRuns(jobId: String) {
    viewModelScope.launch {
      _runs.update { it + (jobId to client.cronRuns(jobId)) }
    }
  }
}
