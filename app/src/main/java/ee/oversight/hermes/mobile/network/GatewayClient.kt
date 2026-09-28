package ee.oversight.hermes.mobile.network

import ee.oversight.hermes.mobile.model.AiModelInfo
import ee.oversight.hermes.mobile.model.BackupResult
import ee.oversight.hermes.mobile.model.Blueprint
import ee.oversight.hermes.mobile.model.CommandInfo
import ee.oversight.hermes.mobile.model.CronJob
import ee.oversight.hermes.mobile.model.CronRun
import ee.oversight.hermes.mobile.model.DebugShare
import ee.oversight.hermes.mobile.model.DoctorCheck
import ee.oversight.hermes.mobile.model.DoctorReport
import ee.oversight.hermes.mobile.model.GatewayStatus
import ee.oversight.hermes.mobile.model.LogLine
import ee.oversight.hermes.mobile.model.MemoryInfo
import ee.oversight.hermes.mobile.model.MobileSession
import ee.oversight.hermes.mobile.model.OpsResult
import ee.oversight.hermes.mobile.model.OpsStatus
import ee.oversight.hermes.mobile.model.PendingApproval
import ee.oversight.hermes.mobile.model.SkillInfo
import ee.oversight.hermes.mobile.model.UsageAnalytics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Talks to the ON-PHONE gateway at 127.0.0.1:8080.
 * Endpoint shapes mirror the real Hermes API server.
 */
class GatewayClient(
  private val base: String = "http://127.0.0.1:8080",
  private val apiKey: () -> String = { "" }
) {
  private val http = OkHttpClient.Builder()
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    .build()

  private val streamHttp = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.SECONDS) // SSE must never time out mid-run
    .writeTimeout(15, TimeUnit.SECONDS)
    .build()

  private val json = "application/json".toMediaType()

  // Base-URL policy (audit hardening): http is allowed only for loopback
  // (localhost, 127.0.0.1). Any other host over http:// is rejected BEFORE
  // connecting so a remote gateway can never be reached (and the API key
  // never sent) in cleartext. https is always allowed.
  init {
    require(isAllowedBase(base)) { "remote gateway must use https" }
  }

  private fun isAllowedBase(raw: String): Boolean {
    val b = raw.trim().lowercase()
    if (b.startsWith("https://")) return true
    if (!b.startsWith("http://")) return true
    val host = b.removePrefix("http://").substringBefore(":").substringBefore("/")
    if (host == "localhost" || host == "127.0.0.1") return true
    return false
  }

  /** True while the VM is installing (mirrors InstallState.INSTALLING, read only).
   *  Set via setInstalling so connection-refused during install reads as
   *  "install in progress" instead of "press Start". Default false preserves
   *  current behavior. The VM owns install state; this is just a display flag. */
  @Volatile
  private var installing: Boolean = false

  fun setInstalling(active: Boolean) { installing = active }

  private fun get(path: String): Request {
    val b = Request.Builder().url("$base$path").get()
    val k = apiKey()
    if (k.isNotBlank()) b.header("Authorization", "Bearer $k")
    return b.build()
  }

  private fun post(path: String, bodyJson: String): Request {
    val b = Request.Builder().url("$base$path").post(bodyJson.toRequestBody(json))
    val k = apiKey()
    if (k.isNotBlank()) b.header("Authorization", "Bearer $k")
    return b.build()
  }

  private fun patch(path: String, bodyJson: String): Request {
    val b = Request.Builder().url("$base$path").patch(bodyJson.toRequestBody(json))
    val k = apiKey()
    if (k.isNotBlank()) b.header("Authorization", "Bearer $k")
    return b.build()
  }

  private fun delete(path: String): Request {
    val b = Request.Builder().url("$base$path").delete()
    val k = apiKey()
    if (k.isNotBlank()) b.header("Authorization", "Bearer $k")
    return b.build()
  }

  suspend fun health(): Boolean = withContext(Dispatchers.IO) {
    try {
      http.newCall(get("/health")).execute().use { it.isSuccessful }
    } catch (_: Exception) { false }
  }

  suspend fun healthDetailed(): GatewayStatus = withContext(Dispatchers.IO) {
    try {
      http.newCall(get("/health/detailed")).execute().use { resp ->
        val txt = resp.body?.string().orEmpty()
        if (!resp.isSuccessful) return@withContext GatewayStatus(false, detail = "HTTP ${resp.code}")
        val o = JSONObject(txt)
        val plats = mutableMapOf<String, String>()
        o.optJSONObject("platforms")?.let { pj ->
          pj.keys().forEach { k -> plats[k] = pj.optJSONObject(k)?.optString("state", "?") ?: "?" }
        }
        GatewayStatus(
          ok = true,
          version = o.optString("version", ""),
          gatewayState = o.optString("gateway_state", o.optJSONObject("readiness")?.optString("status", "").orEmpty()),
          platforms = plats
        )
      }
    } catch (e: Exception) {
      GatewayStatus(false, detail = e.message ?: "unreachable")
    }
  }

  suspend fun modelOptions(): List<AiModelInfo> = withContext(Dispatchers.IO) {
    try {
      http.newCall(get("/api/model/options")).execute().use { resp ->
        if (!resp.isSuccessful) return@withContext emptyList()
        parseModels(JSONObject(resp.body?.string().orEmpty()))
      }
    } catch (_: Exception) { emptyList() }
  }

  private fun parseModels(o: JSONObject): List<AiModelInfo> {
    // Real shape: {providers:[{slug,name,models:[str]}], model, provider}
    val out = mutableListOf<AiModelInfo>()
    val seen = mutableSetOf<String>()
    val providers = o.optJSONArray("providers") ?: return out
    for (i in 0 until providers.length()) {
      val p = providers.optJSONObject(i) ?: continue
      val models = p.optJSONArray("models") ?: continue
      for (j in 0 until models.length()) {
        val id = models.optString(j)
        if (id.isBlank() || "embed" in id.lowercase() || id in seen) continue
        seen += id
        val clean = id.substringAfterLast('/')
          .replace("-", " ").replace("_", " ")
          .replaceFirstChar { it.uppercase() }
        out += AiModelInfo(id, clean)
      }
    }
    return out
  }

  suspend fun sessions(limit: Int = 100, offset: Int = 0): Pair<List<MobileSession>, Boolean> =
    withContext(Dispatchers.IO) {
      try {
        http.newCall(get("/api/sessions?limit=$limit&offset=$offset")).execute().use { resp ->
          if (!resp.isSuccessful) return@withContext Pair(emptyList(), false)
          val o = JSONObject(resp.body?.string().orEmpty())
          val arr = o.optJSONArray("data") ?: o.optJSONArray("sessions") ?: JSONArray()
          val list = mutableListOf<MobileSession>()
          for (i in 0 until arr.length()) {
            val s = arr.optJSONObject(i) ?: continue
            val started = s.optDouble("started_at", 0.0)
            val last = s.optDouble("last_active", started)
            list += MobileSession(
              id = s.optString("id"),
              title = s.optString("title", "untitled"),
              model = s.optString("model", ""),
              messageCount = s.optInt("message_count", 0),
              lastActiveAt = (last * 1000).toLong(),
              costUsd = s.optDouble("actual_cost_usd", s.optDouble("estimated_cost_usd", 0.0)),
              source = s.optString("source", "")
            )
          }
          Pair(list, o.optBoolean("has_more", false))
        }
      } catch (_: Exception) { Pair(emptyList(), false) }
    }

  suspend fun createSession(model: String): String? = withContext(Dispatchers.IO) {
    try {
      val body = if (model.isBlank()) "{}" else JSONObject().put("model", model).toString()
      http.newCall(post("/api/sessions", body)).execute().use { resp ->
        if (!resp.isSuccessful) return@withContext null
        val o = JSONObject(resp.body?.string().orEmpty())
        val s = o.optJSONObject("session") ?: o
        s.optString("id", null)
      }
    } catch (_: Exception) { null }
  }

  suspend fun sessionMessages(sessionId: String, pageSize: Int = 200): List<Pair<String, String>> =
    withContext(Dispatchers.IO) {
      // Pages like Hermes Control (up to ~10k). Server forces oldest-first when
      // limit is passed, so page forward and keep everything.
      val out = mutableListOf<Pair<String, String>>()
      var offset = 0
      try {
        while (out.size < 10_000) {
          val resp = http.newCall(get("/api/sessions/$sessionId/messages?limit=$pageSize&offset=$offset"))
            .execute()
          val arr = resp.use {
            if (!it.isSuccessful) return@withContext out
            (JSONObject(it.body?.string().orEmpty())).optJSONArray("data") ?: JSONArray()
          }
          if (arr.length() == 0) break
          for (i in 0 until arr.length()) {
            val m = arr.optJSONObject(i) ?: continue
            val role = m.optString("role", "user")
            if (role == "tool" || role == "system") continue
            val text = m.optString("content", "").trim()
            if (text.isEmpty()) continue
            if (text.startsWith("{\"output\":") || text.startsWith("{\"total_count\":") ||
              (text.startsWith("{\"success\":") && text.contains("\"exit_code\""))
            ) continue
            out += (if (role == "assistant") "hermes" else "you") to text
          }
          if (arr.length() < pageSize) break
          offset += arr.length()
        }
        out
      } catch (_: Exception) { out.ifEmpty { emptyList() } }
    }

  suspend fun renameSession(id: String, title: String): Boolean = withContext(Dispatchers.IO) {
    try {
      val body = JSONObject().put("title", title).toString()
      http.newCall(patch("/api/sessions/$id", body)).execute().use { it.isSuccessful }
    } catch (_: Exception) { false }
  }

  suspend fun forkSession(id: String): String? = withContext(Dispatchers.IO) {
    try {
      http.newCall(post("/api/sessions/$id/fork", "{}")).execute().use { resp ->
        if (!resp.isSuccessful) return@withContext null
        val o = JSONObject(resp.body?.string().orEmpty())
        (o.optJSONObject("session") ?: o).optString("id", null)
      }
    } catch (_: Exception) { null }
  }

  suspend fun deleteSession(id: String): Boolean = withContext(Dispatchers.IO) {
    try {
      http.newCall(delete("/api/sessions/$id")).execute().use { it.isSuccessful }
    } catch (_: Exception) { false }
  }

  /** Streams a chat turn. Event names arrive on `event:` lines (server stamps
   *  only ids into data JSON). Calls onText/onThinking/onTool as deltas arrive,
   *  onApproval when the run parks on approval.request. `onRunId` fires once
   *  with the server run_id stamped into the event envelope (used for Stop).
   *  `onThinkingDone` fires once when the thinking phase ends: the first
   *  text/tool/completion event after thinking deltas, or the terminal
   *  event when a turn thought without any following delta. The server sends
   *  no explicit thinking-done frame, so this is derived client-side.
   *  `onToolOutput` carries structured tool results (tool.completed/failed
   *  envelopes: output/result/preview fields) alongside the legacy
   *  name-only onTool call, which is kept for the VM's string list.
   *  `reasoningEffort` (none/low/medium/high): sent as
   *  model_options={reasoning_effort} when non-blank and != none (Control
   *  pattern; honored by _request_agent_overrides on chat/stream).
   *  `imageDataUrls`: data:image/... URLs sent as OpenAI vision parts
   *  message=[{type:text},{type:image_url,image_url:{url}}]. */
  suspend fun streamChat(
    sessionId: String,
    model: String,
    message: String,
    onText: (String) -> Unit,
    onThinking: (String) -> Unit,
    onTool: (String) -> Unit,
    onUsage: (Long, Long) -> Unit,
    onApproval: (PendingApproval) -> Unit = {},
    reasoningEffort: String = "",
    imageDataUrls: List<String> = emptyList(),
    onRunId: (String) -> Unit = {},
    onThinkingDone: () -> Unit = {},
    onToolOutput: (toolName: String, output: String) -> Unit = { _, _ -> }
  ): Result<Unit> = withContext(Dispatchers.IO) {
    try {
      val body = JSONObject()
      if (imageDataUrls.isEmpty()) {
        body.put("message", message)
      } else {
        val parts = JSONArray()
        if (message.isNotBlank()) {
          parts.put(JSONObject().put("type", "text").put("text", message))
        }
        for (url in imageDataUrls) {
          parts.put(JSONObject().put("type", "image_url")
            .put("image_url", JSONObject().put("url", url)))
        }
        body.put("message", parts)
      }
      if (model.isNotBlank()) body.put("model", model)
      val effort = reasoningEffort.trim().lowercase()
      if (effort.isNotBlank() && effort != "none") {
        body.put("model_options", JSONObject().put("reasoning_effort", effort))
      }
      val req = run {
        val b = Request.Builder().url("$base/api/sessions/$sessionId/chat/stream")
          .post(body.toString().toRequestBody(json))
        val k = apiKey()
        if (k.isNotBlank()) b.header("Authorization", "Bearer $k")
        b.build()
      }
      val call = streamHttp.newCall(req)
      // Stop cancels the collector job: kill the socket too, or the blocking
      // readUtf8Line loop below keeps emitting orphan frames after Stop.
      coroutineContext[Job]?.invokeOnCompletion { cause ->
        if (cause is kotlinx.coroutines.CancellationException) call.cancel()
      }
      call.execute().use { resp ->
        if (!resp.isSuccessful) {
          val err = resp.body?.string().orEmpty().take(300)
          return@withContext Result.failure(RuntimeException("HTTP ${resp.code} $err"))
        }
        val src = resp.body?.source() ?: return@withContext Result.success(Unit)
        var eventName = ""
        var gotDone = false
        var gotContent = false
        var failMsg: String? = null
        var runIdSent = false
        // Derived thinking phase: no explicit server frame exists, so the
        // first non-thinking event after thinking deltas ends the phase.
        var thinkingActive = false
        fun endThinking() {
          if (thinkingActive) {
            thinkingActive = false
            try { onThinkingDone() } catch (_: Exception) { }
          }
        }
        while (true) {
          // Stop cancels streamJob: readUtf8Line blocks with no cancellation
          // wiring, so poll isActive each lap and break before emitting orphans.
          if (!coroutineContext.isActive) break
          val line = try { src.readUtf8Line() } catch (_: Exception) { null } ?: break
          if (!coroutineContext.isActive) break
          if (line.startsWith("event:")) { eventName = line.removePrefix("event:").trim(); continue }
          if (!line.startsWith("data:")) continue
          val payload = line.removePrefix("data:").trim()
          if (payload.isEmpty()) continue
          try {
            val ev = JSONObject(payload)
            // Server stamps run_id into every event envelope: capture it once
            // so Stop can target POST /v1/runs/{id}/stop for this exact turn.
            if (!runIdSent) {
              val rid = ev.optString("run_id", "")
              if (rid.isNotBlank()) { runIdSent = true; onRunId(rid) }
            }
            // OpenAI-compatible fallback frame
            if (ev.has("choices")) {
              val delta = ev.optJSONArray("choices")?.optJSONObject(0)
                ?.optJSONObject("delta")?.optString("content", "").orEmpty()
              if (delta.isNotEmpty()) { gotContent = true; onText(delta) }
              continue
            }
            when (eventName) {
              "assistant.delta" -> {
                endThinking()
                val d = ev.optString("delta", "")
                if (d.isNotEmpty()) { gotContent = true; onText(d) }
              }
              // Mid-turn assistant text beside tool calls; never folded into
              // assistant.completed server-side, so consume it here or it is lost.
              "assistant.commentary" -> {
                endThinking()
                if (!ev.optBoolean("already_streamed", false)) {
                  val t = ev.optString("text", "")
                  if (t.isNotEmpty()) { gotContent = true; onText(t) }
                }
              }
              "tool.started" -> {
                endThinking()
                onTool(ev.optString("tool_name", "tool"))
              }
              "tool.progress" -> {
                if (ev.optString("tool_name") == "_thinking" || ev.optString("tool_name") == "thinking") {
                  val d = ev.optString("delta", ev.optString("preview", ""))
                  if (d.isNotEmpty()) { gotContent = true; thinkingActive = true; onThinking(d) }
                } else {
                  endThinking()
                  onTool(ev.optString("tool_name", "tool"))
                }
              }
              "tool.completed", "tool.failed" -> {
                endThinking()
                val name = ev.optString("tool_name", "tool")
                onTool(name)
                // Structured result beside the legacy name call; blank when
                // the envelope carries ids only (server stamps just ids).
                val out = ev.optString("output",
                  ev.optString("result", ev.optString("preview", "")))
                if (out.isNotEmpty()) {
                  try { onToolOutput(name, out) } catch (_: Exception) { }
                }
              }
              "assistant.completed", "run.completed" -> {
                endThinking()
                val u = ev.optJSONObject("usage")
                if (u != null) onUsage(u.optLong("input_tokens", 0), u.optLong("output_tokens", 0))
                val content = ev.optString("content", "")
                if (!gotContent && content.isNotEmpty()) { gotContent = true; onText(content) }
                gotDone = true
              }
              "run.failed", "run.cancelled" -> {
                failMsg = ev.optString("message", ev.optString("error", "run $eventName"))
                gotDone = true
              }
              "approval.request" -> {
                // Real shape: approval_data {command, description, request_id,
                // allow_*, smart_denied} + envelope {run_id, session_id, ...}.
                // approval.request parks the turn; the follow-up `done` ends it.
                gotContent = true
                val cmd = ev.optString("command",
                  ev.optString("payload", ev.optString("preview", "")))
                val why = ev.optString("description", "")
                val label = if (why.isNotBlank() && cmd.isNotBlank()) "$why: $cmd"
                  else if (cmd.isNotBlank()) cmd else why.ifBlank { "approval" }
                onApproval(PendingApproval(
                  ev.optString("run_id", ""),
                  ev.optString("session_id", sessionId),
                  label.take(300)
                ))
              }
              "error" -> failMsg = ev.optString("message", "Unknown error")
              "done" -> { endThinking(); gotDone = true }
            }
          } catch (_: Exception) { /* keep-alive or non-JSON frame */ }
        }
        if (failMsg != null) Result.failure(RuntimeException(failMsg))
        else if (!coroutineContext.isActive) throw kotlinx.coroutines.CancellationException("stream stopped")
        else if (!gotDone && gotContent)
          Result.failure(RuntimeException("connection dropped before the reply finished"))
        else Result.success(Unit)
      }
    } catch (e: Exception) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Result.failure(e)
    }
  }

  suspend fun jobs(): List<CronJob> = withContext(Dispatchers.IO) {
    try {
      http.newCall(get("/api/jobs")).execute().use { resp ->
        if (!resp.isSuccessful) return@withContext emptyList()
        val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("jobs") ?: JSONArray()
        val out = mutableListOf<CronJob>()
        for (i in 0 until arr.length()) {
          val j = arr.optJSONObject(i) ?: continue
          out += CronJob(
            id = j.optString("id"),
            name = j.optString("name", "job"),
            scheduleDisplay = j.optString("schedule_display", j.optJSONObject("schedule")?.optString("display", "").orEmpty()),
            prompt = j.optString("prompt", ""),
            enabled = j.optBoolean("enabled", j.optString("state") != "paused"),
            state = j.optString("state", ""),
            nextRunAt = j.optString("next_run_at", ""),
            lastStatus = j.optString("last_status", ""),
            lastError = j.optString("last_error",
              j.optString("lastError",
                j.optString("error",
                  j.optJSONObject("last_run")?.optString("error", "").orEmpty())))
          )
        }
        out
      }
    } catch (_: Exception) { emptyList() }
  }

  suspend fun createJob(name: String, schedule: String, prompt: String): Boolean =
    withContext(Dispatchers.IO) {
      try {
        val body = JSONObject().put("name", name).put("schedule", schedule)
          .put("prompt", prompt).put("deliver", "local").toString()
        http.newCall(post("/api/jobs", body)).execute().use { it.isSuccessful }
      } catch (_: Exception) { false }
    }

  suspend fun jobAction(id: String, action: String): Boolean = withContext(Dispatchers.IO) {
    try {
      if (action == "delete") {
        http.newCall(delete("/api/jobs/$id")).execute().use { it.isSuccessful }
      } else {
        http.newCall(post("/api/jobs/$id/$action", "{}")).execute().use { it.isSuccessful }
      }
    } catch (_: Exception) { false }
  }

  // NOTE: no such route exists on stock hermes-agent (runs expose only
  // POST /v1/runs, GET /v1/runs/{id}[/events], POST .../approval|steer|stop),
  // so this 404s to empty. Approvals surface via live-stream approval.request;
  // anything parked while the app was closed is invisible until re-streamed.
  suspend fun pendingApprovals(): List<PendingApproval> = withContext(Dispatchers.IO) {
    try {
      http.newCall(get("/v1/approvals/pending")).execute().use { resp ->
        if (!resp.isSuccessful) return@withContext emptyList() // 404 = stock server, fine
        val o = JSONObject(resp.body?.string().orEmpty())
        val arr = o.optJSONArray("approvals") ?: o.optJSONArray("pending") ?: JSONArray()
        val out = mutableListOf<PendingApproval>()
        for (i in 0 until arr.length()) {
          val a = arr.optJSONObject(i) ?: continue
          out += PendingApproval(
            runId = a.optString("run_id"),
            sessionId = a.optString("session_id", ""),
            summary = a.optString("summary", a.optString("tool_name", "approval"))
          )
        }
        out
      }
    } catch (_: Exception) { emptyList() }
  }

  suspend fun resolveApproval(runId: String, allow: Boolean, mode: String = "once"): Boolean =
    withContext(Dispatchers.IO) {
      try {
        val body = if (!allow) JSONObject().put("choice", "deny").toString()
        else JSONObject().put("choice", when (mode) { "session" -> "session"; "always" -> "always"; else -> "once" }).toString()
        http.newCall(post("/v1/runs/$runId/approval", body)).execute().use { it.isSuccessful }
      } catch (_: Exception) { false }
    }

  // ---- Defensive probe helpers: null/empty on 404 or error, never throw ----

  private fun getObj(path: String): JSONObject? {
    return try {
      http.newCall(get(path)).execute().use { resp ->
        if (!resp.isSuccessful) return null
        JSONObject(resp.body?.string().orEmpty())
      }
    } catch (_: Exception) { null }
  }

  private fun firstObj(vararg paths: String): JSONObject? {
    for (p in paths) {
      val o = getObj(p)
      if (o != null) return o
    }
    return null
  }

  private fun postOk(path: String, bodyJson: String = "{}"): Boolean {
    return try {
      http.newCall(post(path, bodyJson)).execute().use { it.isSuccessful }
    } catch (_: Exception) { false }
  }

  private fun postObj(path: String, bodyJson: String = "{}"): JSONObject? {
    return try {
      http.newCall(post(path, bodyJson)).execute().use { resp ->
        if (!resp.isSuccessful) return null
        val t = resp.body?.string().orEmpty()
        if (t.isBlank()) JSONObject() else JSONObject(t)
      }
    } catch (_: Exception) { null }
  }

  private fun enc(v: String): String = URLEncoder.encode(v, "UTF-8")

  private fun parseCronJob(j: JSONObject): CronJob = CronJob(
    id = j.optString("id"),
    name = j.optString("name", "job"),
    scheduleDisplay = j.optString("schedule_display", j.optJSONObject("schedule")?.optString("display", "").orEmpty()),
    prompt = j.optString("prompt", ""),
    enabled = j.optBoolean("enabled", j.optString("state") != "paused"),
    state = j.optString("state", ""),
    nextRunAt = j.optString("next_run_at", ""),
    lastStatus = j.optString("last_status", ""),
    lastError = j.optString("last_error",
      j.optString("lastError",
        j.optString("error",
          j.optJSONObject("last_run")?.optString("error", "").orEmpty())))
  )

  suspend fun cronJob(id: String): CronJob? = withContext(Dispatchers.IO) {
    val o = firstObj("/api/jobs/$id", "/api/cron/$id") ?: return@withContext null
    val j = o.optJSONObject("job") ?: o
    if (j.optString("id", id).isBlank() && !j.has("name")) return@withContext null
    try { parseCronJob(j) } catch (_: Exception) { null }
  }

  suspend fun cronRuns(id: String): List<CronRun> = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/jobs/$id/runs", "/api/cron/$id/runs") ?: return@withContext emptyList()
      val arr = o.optJSONArray("runs") ?: o.optJSONArray("data") ?: JSONArray()
      val out = mutableListOf<CronRun>()
      for (i in 0 until arr.length()) {
        val r = arr.optJSONObject(i) ?: continue
        out += CronRun(
          id = r.optString("id", r.optString("run_id", "$i")),
          jobId = r.optString("job_id", id),
          status = r.optString("status", r.optString("state", "")),
          startedAt = r.optString("started_at", r.optString("startedAt", "")),
          finishedAt = r.optString("finished_at", r.optString("finishedAt", "")),
          error = r.optString("error", "")
        )
      }
      out
    } catch (_: Exception) { emptyList() }
  }

  suspend fun updateJob(id: String, schedule: String = "", prompt: String = ""): Boolean =
    withContext(Dispatchers.IO) {
      try {
        val body = JSONObject()
        if (schedule.isNotBlank()) body.put("schedule", schedule)
        if (prompt.isNotBlank()) body.put("prompt", prompt)
        http.newCall(patch("/api/jobs/$id", body.toString())).execute().use { resp ->
          if (resp.isSuccessful) return@withContext true
          if (resp.code == 404) {
            return@withContext postOk("/api/jobs/$id/edit", body.toString())
          }
          false
        }
      } catch (_: Exception) { false }
    }

  suspend fun blueprints(): List<Blueprint> = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/blueprints", "/api/skills/blueprints") ?: return@withContext emptyList()
      val arr = o.optJSONArray("blueprints") ?: o.optJSONArray("data") ?: JSONArray()
      val out = mutableListOf<Blueprint>()
      for (i in 0 until arr.length()) {
        val b = arr.optJSONObject(i) ?: continue
        out += Blueprint(
          id = b.optString("id", b.optString("name", "$i")),
          name = b.optString("name", b.optString("id", "blueprint")),
          description = b.optString("description", "")
        )
      }
      out
    } catch (_: Exception) { emptyList() }
  }

  suspend fun instantiateBlueprint(id: String, slots: Map<String, String> = emptyMap()): Boolean =
    withContext(Dispatchers.IO) {
      try {
        val body = JSONObject().put("slots", JSONObject(slots as Map<*, *>)).toString()
        if (postOk("/api/blueprints/$id/instantiate", body)) return@withContext true
        postOk("/api/blueprints/$id/run", body)
      } catch (_: Exception) { false }
    }

  suspend fun usageAnalytics(range: String = "7d"): UsageAnalytics? = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/usage?range=${enc(range)}", "/api/insights?range=${enc(range)}")
        ?: return@withContext null
      val u = o.optJSONObject("usage") ?: o
      UsageAnalytics(
        range = range,
        sessions = u.optInt("sessions", u.optInt("session_count", 0)),
        messages = u.optInt("messages", u.optInt("message_count", 0)),
        costUsd = u.optDouble("cost_usd", u.optDouble("total_cost_usd", 0.0)),
        inputTokens = u.optLong("input_tokens", 0L),
        outputTokens = u.optLong("output_tokens", 0L)
      )
    } catch (_: Exception) { null }
  }

  suspend fun serverLogs(
    file: String = "",
    level: String = "",
    query: String = "",
    limit: Int = 200
  ): List<LogLine> = withContext(Dispatchers.IO) {
    try {
      val q = buildString {
        append("?limit=$limit")
        if (file.isNotBlank()) append("&file=${enc(file)}")
        if (level.isNotBlank()) append("&level=${enc(level)}")
        if (query.isNotBlank()) append("&query=${enc(query)}")
      }
      val o = firstObj("/api/logs$q", "/api/gateway/logs$q") ?: return@withContext emptyList()
      val arr = o.optJSONArray("logs") ?: o.optJSONArray("lines") ?: o.optJSONArray("data") ?: JSONArray()
      val out = mutableListOf<LogLine>()
      for (i in 0 until arr.length()) {
        val s = arr.opt(i) ?: continue
        if (s is String) { out += LogLine(message = s); continue }
        val l = arr.optJSONObject(i) ?: continue
        out += LogLine(
          timestamp = l.optString("timestamp", l.optString("ts", "")),
          level = l.optString("level", ""),
          file = l.optString("file", file),
          message = l.optString("message", l.optString("text", l.toString()))
        )
      }
      out
    } catch (_: Exception) { emptyList() }
  }

  suspend fun restartGateway(): Boolean = withContext(Dispatchers.IO) {
    if (postOk("/api/gateway/restart")) return@withContext true
    postOk("/api/restart")
  }

  suspend fun opsRun(action: String): OpsResult? = withContext(Dispatchers.IO) {
    try {
      val o = postObj("/api/ops/$action")
        ?: postObj("/api/gateway/$action")
        ?: return@withContext null
      OpsResult(
        ok = o.optBoolean("ok", o.optBoolean("success", false)),
        message = o.optString("message", o.optString("detail", ""))
      )
    } catch (_: Exception) { null }
  }

  suspend fun opsStatus(name: String): OpsStatus? = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/ops/${enc(name)}/status", "/api/ops/status?name=${enc(name)}")
        ?: return@withContext null
      val s = o.optJSONObject("status") ?: o
      OpsStatus(
        name = name,
        state = s.optString("state", s.optString("status", "")),
        detail = s.optString("detail", s.optString("message", ""))
      )
    } catch (_: Exception) { null }
  }

  suspend fun debugShare(): DebugShare? = withContext(Dispatchers.IO) {
    try {
      val o = postObj("/api/debug/share") ?: postObj("/api/debug/upload") ?: return@withContext null
      val urls = mutableListOf<String>()
      o.optString("url", "").ifBlank { null }?.let { urls += it }
      o.optString("link", "").ifBlank { null }?.let { urls += it }
      val arr = o.optJSONArray("urls") ?: o.optJSONArray("links")
      if (arr != null) for (i in 0 until arr.length()) {
        val u = arr.optString(i)
        if (u.isNotBlank()) urls += u
      }
      DebugShare(urls = urls, summary = o.optString("summary", ""))
    } catch (_: Exception) { null }
  }

  suspend fun doctor(): DoctorReport? = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/doctor", "/api/health/detailed") ?: return@withContext null
      val checks = mutableListOf<DoctorCheck>()
      val arr = o.optJSONArray("checks") ?: o.optJSONArray("results")
      if (arr != null) for (i in 0 until arr.length()) {
        val c = arr.optJSONObject(i) ?: continue
        checks += DoctorCheck(
          name = c.optString("name", "check"),
          ok = c.optBoolean("ok", c.optBoolean("pass", c.optBoolean("success", true))),
          detail = c.optString("detail", c.optString("message", ""))
        )
      }
      DoctorReport(
        ok = o.optBoolean("ok", o.optBoolean("healthy", checks.all { it.ok })),
        summary = o.optString("summary", o.optString("detail", "")),
        version = o.optString("version", ""),
        checks = checks
      )
    } catch (_: Exception) { null }
  }

  suspend fun backup(): BackupResult? = withContext(Dispatchers.IO) {
    try {
      val o = postObj("/api/backup") ?: postObj("/api/snapshot") ?: return@withContext null
      BackupResult(
        ok = o.optBoolean("ok", o.optBoolean("success", false)),
        path = o.optString("path", o.optString("file", "")),
        message = o.optString("message", o.optString("detail", ""))
      )
    } catch (_: Exception) { null }
  }

  suspend fun skillsList(): List<SkillInfo> = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/skills", "/api/tools/skills") ?: return@withContext emptyList()
      val arr = o.optJSONArray("skills") ?: o.optJSONArray("data") ?: JSONArray()
      val out = mutableListOf<SkillInfo>()
      for (i in 0 until arr.length()) {
        val s = arr.optJSONObject(i) ?: continue
        val id = s.optString("id", s.optString("name", "$i"))
        out += SkillInfo(
          id = id,
          name = s.optString("name", id),
          description = s.optString("description", ""),
          enabled = s.optBoolean("enabled", s.optString("state") != "disabled")
        )
      }
      out
    } catch (_: Exception) { emptyList() }
  }

  suspend fun skillToggle(id: String, on: Boolean): Boolean = withContext(Dispatchers.IO) {
    val verb = if (on) "enable" else "disable"
    try {
      if (postOk("/api/skills/$id/$verb")) return@withContext true
      http.newCall(patch("/api/skills/$id", JSONObject().put("enabled", on).toString()))
        .execute().use { it.isSuccessful }
    } catch (_: Exception) { false }
  }

  suspend fun memoryGet(): MemoryInfo? = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/memory", "/api/session/memory") ?: return@withContext null
      val m = o.optJSONObject("memory") ?: o
      MemoryInfo(
        enabled = m.optBoolean("enabled", m.optBoolean("memory_enabled", false)),
        provider = m.optString("provider", ""),
        summary = m.optString("summary", ""),
        entries = m.optInt("entries", m.optInt("entry_count", 0))
      )
    } catch (_: Exception) { null }
  }

  /** Live-probe a provider credential. Tri-state (mirrors Desktop
   *  POST /api/providers/validate {ok, reachable}):
   *  true = provider accepted the key, false = provider rejected it,
   *  null = could not verify (old gateway without the endpoint, no live
   *  probe for this provider, or network failed) — caller must NOT block. */
  suspend fun providersValidate(slug: String, envKey: String, key: String): Boolean? =
    withContext(Dispatchers.IO) {
    try {
      // Desktop shape: body.key = ENV VAR NAME (OPENCODE_GO_API_KEY etc).
      val desktopBody = JSONObject().put("key", envKey).put("value", key)
        .put("api_key", key).toString()
      // Legacy fallback shape (unknown gateway): slug + secret, no fake "key".
      val legacyBody = JSONObject().put("provider", slug).put("slug", slug)
        .put("api_key", key).toString()
      val o = postObj("/api/providers/validate", desktopBody)
        ?: postObj("/api/model/validate", legacyBody) ?: return@withContext null
      if (!o.has("ok") && !o.has("valid") && !o.has("success") &&
          !o.has("reachable")) return@withContext null
      val reachable = o.optBoolean("reachable", true)
      val ok = o.optBoolean("ok", o.optBoolean("valid",
        o.optBoolean("success", false)))
      if (ok) true else if (reachable) false else null
    } catch (_: Exception) { null }
  }

  suspend fun lockSessionModel(sessionId: String, model: String): Boolean =
    withContext(Dispatchers.IO) {
      try {
        val body = JSONObject().put("model", model).put("lock_model", true).toString()
        http.newCall(patch("/api/sessions/$sessionId", body)).execute().use { resp ->
          if (resp.isSuccessful) return@withContext true
          if (resp.code == 404) {
            return@withContext postOk("/api/sessions/$sessionId/model/lock", body)
          }
          false
        }
      } catch (_: Exception) { false }
    }

  suspend fun commandsCatalog(): List<CommandInfo> = withContext(Dispatchers.IO) {
    try {
      val o = firstObj("/api/commands", "/api/slash-commands") ?: return@withContext emptyList()
      val arr = o.optJSONArray("commands") ?: o.optJSONArray("data") ?: JSONArray()
      val out = mutableListOf<CommandInfo>()
      for (i in 0 until arr.length()) {
        val c = arr.optJSONObject(i) ?: continue
        out += CommandInfo(
          name = c.optString("name", c.optString("command", "")),
          description = c.optString("description", c.optString("help", ""))
        )
      }
      out.filter { it.name.isNotBlank() }
    } catch (_: Exception) { emptyList() }
  }

  suspend fun complete(prefix: String, limit: Int = 20): List<String> =
    withContext(Dispatchers.IO) {
      try {
        val o = firstObj(
          "/api/complete?prefix=${enc(prefix)}&limit=$limit",
          "/api/commands/complete?prefix=${enc(prefix)}&limit=$limit"
        ) ?: return@withContext emptyList()
        val arr = o.optJSONArray("completions") ?: o.optJSONArray("suggestions")
          ?: o.optJSONArray("data") ?: JSONArray()
        val out = mutableListOf<String>()
        for (i in 0 until arr.length()) {
          val s = arr.opt(i) ?: continue
          val t = if (s is String) s else arr.optJSONObject(i)?.optString("name", "")
          if (!t.isNullOrBlank()) out += t
        }
        out
      } catch (_: Exception) { emptyList() }
    }

  // NOTE: Desktop Stop sends `session.interrupt` over the gateway RPC socket,
  // which has NO HTTP equivalent: the HTTP API exposes no
  // POST /api/sessions/{id}/interrupt (verified against api_server.py route
  // table). Over HTTP the matching server-side stop is
  // POST /v1/runs/{run_id}/stop, so Stop = cancel the local stream (drops the
  // SSE read) AND stopRun(runId) when the stream already reported its run_id.
  suspend fun stopRun(runId: String): Boolean = withContext(Dispatchers.IO) {
    if (postOk("/v1/runs/$runId/stop")) return@withContext true
    postOk("/v1/runs/$runId/cancel")
  }

  // NOTE: probed POST /api/files {filename, content_b64}: no such route exists
  // on the gateway (only POST /v1/artifacts/upload, browser-control scoped, not
  // for chat) — so generic file-attach stays disabled and the composer offers
  // images only (inline data-URL vision parts, no upload endpoint needed).
  // Kept as a graceful capability probe for a future /api/files route.
  suspend fun filesUploadSupported(): Boolean = withContext(Dispatchers.IO) {
    try {
      val probe = JSONObject().put("filename", ".probe").put("content_b64", "").toString()
      http.newCall(post("/api/files", probe)).execute().use { resp ->
        resp.code != 404
      }
    } catch (_: Exception) { false }
  }

  fun friendlyError(e: Throwable): String {
    val m = (e.message ?: "").lowercase()
    return when {
      m.contains("timeout") -> "timed out, the model may still be working, retry"
      m.contains("refused") || m.contains("failed to connect") ->
        if (installing) "install in progress, wait for the download to finish"
        else "gateway is not running, press Start"
      m.contains("resolve") || m.contains("dns") || m.contains("unknownhost") -> "network error, check connection"
      m.contains("dropped before") -> "connection dropped mid-reply, tap send to retry"
      else -> "connection error: ${(e.message ?: "unknown").take(120)}"
    }
  }
}
