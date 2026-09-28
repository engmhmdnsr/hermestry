package ee.oversight.hermes.mobile.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.net.wifi.WifiManager
import ee.oversight.hermes.mobile.normProvider
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import ee.oversight.hermes.mobile.install.Bootstrap
import ee.oversight.hermes.mobile.security.SecurePrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Foreground service that owns the on-phone gateway process.
 * Starts proot + `hermes gateway run`, watches the log for the
 * listen line, restarts on crash while the service is alive.
 */
class MobileGatewayService : Service() {
  private val scope = CoroutineScope(Dispatchers.IO)
  private var watchJob: Job? = null
  private var gatewayProc: Process? = null
  private var logOut: java.io.OutputStream? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var installJob: Job? = null
  @Volatile private var wantRun = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "STOP") {
      wantRun = false
      stopGateway()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action == "INSTALL") {
      // One-shot image install inside the foreground service: FGS state
      // exempts the process from Doze/freezer kills when the screen sleeps.
      startForegroundInternal("Installing Hermes image", "downloading, do not close the app")
      if (installJob == null) {
        installJob = scope.launch {
          try { runInstall() } finally { installJob = null }
        }
      }
      return START_STICKY
    }
    startForegroundInternal()
    if (watchJob == null) {
      wantRun = true
      // A FAILED supervisor stops auto-retry; only an explicit user Start
      // clears it and launches a fresh supervise loop.
      gatewayFailed.value = false
      gatewayFailureReason.value = null
      // Declared WAKE_LOCK exists so Doze does not throttle the "always-on" gateway.
      // Bounded: 10 min timeout, re-acquired in supervise() while still wanted.
      if (wakeLock == null) {
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hermes:gateway")
      }
      try { wakeLock?.acquire(WAKE_TIMEOUT_MS) } catch (_: Exception) { }
      watchJob = scope.launch {
        try { supervise() } finally {
          // Supervise returned (FAILED or stopped): allow a later explicit
          // Start to launch a fresh loop.
          if (!wantRun || gatewayFailed.value) watchJob = null
        }
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    wantRun = false
    stopGateway()
    watchJob?.cancel()
    watchJob = null
    installJob?.cancel()
    installJob = null
    try { wakeLock?.release() } catch (_: Exception) { }
    wakeLock = null
    super.onDestroy()
  }

  private fun startForegroundInternal(
    title: String = "Hermes Mobile running",
    text: String = "on-phone gateway on localhost:8080"
  ) {
    // The Capacitor app has no custom Application class, so the service owns
    // its own notify channel (idempotent). No notification permission needed
    // for the FGS notification itself.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
          NotificationChannel("gateway", "Hermes gateway", NotificationManager.IMPORTANCE_LOW)
        )
      } catch (_: Exception) { }
    }
    val n: Notification = NotificationCompat.Builder(this, "gateway")
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // specialUse needs API 34+; older releases fall back to dataSync.
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      startForeground(1, n, type)
    } else {
      startForeground(1, n)
    }
  }

  /** Re-acquire the bounded WakeLock while the supervisor still wants to run. */
  private fun ensureWake() {
    try {
      if (wantRun && wakeLock?.isHeld != true) wakeLock?.acquire(WAKE_TIMEOUT_MS)
    } catch (_: Exception) { }
  }

  private suspend fun supervise() {
    var backoff = 5_000L
    var failures = 0
    while (wantRun) {
      ensureWake()
      try {
        Bootstrap.renderConfig(this@MobileGatewayService)
        startGateway()
        backoff = 5_000L
        // Wait for the listen line, then monitor the process.
        val up = waitForListen(90_000L)
        if (!wantRun) break
        if (!up) {
          failures++
          appendLog("gateway start timeout, see gateway.log (attempt $failures/$MAX_RESTARTS)")
          if (failures >= MAX_RESTARTS) {
            failSupervisor("gateway did not become reachable after $MAX_RESTARTS attempts, see gateway.log")
            break
          }
        } else {
          appendLog("gateway listening on 127.0.0.1:8080")
          failures = 0
          while (wantRun && gatewayProc?.isAlive == true) {
            ensureWake()
            delay(5_000)
          }
          if (!wantRun) break
          failures++
          appendLog("gateway exited, restarting... (attempt $failures/$MAX_RESTARTS)")
          if (failures >= MAX_RESTARTS) {
            failSupervisor("gateway process keeps exiting ($MAX_RESTARTS attempts), see gateway.log")
            break
          }
        }
      } catch (e: Exception) {
        failures++
        appendLog("gateway supervisor: ${e.message} (attempt $failures/$MAX_RESTARTS)")
        if (failures >= MAX_RESTARTS) {
          failSupervisor("gateway supervisor error: ${e.message}")
          break
        }
      }
      stopGateway()
      if (!wantRun) break
      delay(backoff)
      backoff = (backoff * 2).coerceAtMost(60_000L)
    }
    stopGateway()
  }

  /** Circuit breaker: mark FAILED and stop auto-retry until explicit Start. */
  private fun failSupervisor(reason: String) {
    stopGateway()
    gatewayFailureReason.value = reason
    gatewayFailed.value = true
    appendLog("gateway FAILED: $reason")
    try { wakeLock?.release() } catch (_: Exception) { }
  }

  /** One-shot image install. Runs under FGS so screen-off cannot kill it. */
  private suspend fun runInstall() {
    val root = Bootstrap.rootDir(this)
    val log = File(root, "install.log")
    val done = File(root, "install.done")
    try { done.delete() } catch (_: Exception) { }
    try { log.delete() } catch (_: Exception) { }
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    val wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hermes:install")
    try { wifiLock.acquire() } catch (_: Exception) { }
    if (wakeLock == null) {
      wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hermes:install")
    }
    try { wakeLock?.acquire(45 * 60 * 1000L) } catch (_: Exception) { }
    try {
      Bootstrap.install(this@MobileGatewayService) { line ->
        try { log.appendText(line + "\n") } catch (_: Exception) { }
      }
      try { done.writeText("ok") } catch (_: Exception) { }
    } catch (e: Exception) {
      try { log.appendText("FAILED: ${e.message}\n") } catch (_: Exception) { }
      try { done.writeText("error: ${e.message}") } catch (_: Exception) { }
    } finally {
      try { if (wifiLock.isHeld) wifiLock.release() } catch (_: Exception) { }
      try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) { }
      // Back to a plain background state; an explicit Start re-enters FGS.
      try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) { }
      try { stopSelf() } catch (_: Exception) { }
    }
  }

  private fun startGateway() {
    stopGateway()
    val proot = Bootstrap.prootFile(this).absolutePath
    val fs = Bootstrap.rootfsDir(this).absolutePath
    val home = Bootstrap.hermesHome(this).absolutePath
    val cfg = File(Bootstrap.rootDir(this), "config.yaml").absolutePath
    val pb = ProcessBuilder(
      proot, "-r", fs,
      "-b", "/dev", "-b", "/proc", "-b", "/sys",
      "-b", "$home:/root",
      "-b", "$cfg:/root/config.yaml",
      "-w", "/root",
      // Baked interpreter: the image ships Python 3.14 at /opt/python314
      // (system python3 is the distro one and is NOT the tested runtime).
      "/opt/python314/python/bin/python3.14", "-m", "hermes_cli.main", "gateway", "run"
    )
    pb.environment()["HERMES_HOME"] = "/root"
    pb.environment()["HOME"] = "/root"
    pb.environment()["USER"] = "root"
    pb.environment()["LOGNAME"] = "root"
    pb.environment()["PYTHONIOENCODING"] = "utf-8"
    pb.environment()["DEBIAN_FRONTEND"] = "noninteractive"
    // Baked hermes-agent tree (mirrors the .pth inside the baked python).
    pb.environment()["PYTHONPATH"] = "/opt/hermes-agent"
    pb.environment()["PATH"] = "/opt/python314/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    pb.environment()["LD_LIBRARY_PATH"] = File(Bootstrap.prootPkgDir(this), "lib").absolutePath
    for ((k, v) in Bootstrap.prootEnv(this)) pb.environment()[k] = v
    Bootstrap.prootLoaderFile(this)?.let { pb.environment()["PROOT_LOADER"] = it.absolutePath }
    Bootstrap.prootLoader32File(this)?.let { pb.environment()["PROOT_LOADER_32"] = it.absolutePath }
    // Same env contract as the PC setup: bind + tokens travel as env, not config.
    val prefs = getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
    // 0.21.x gates the API server on env (config.yaml platforms block alone
    // does NOT start it; verified on-device: no listener without this flag).
    pb.environment()["API_SERVER_ENABLED"] = "true"
    pb.environment()["API_SERVER_HOST"] = "127.0.0.1"
    pb.environment()["API_SERVER_PORT"] = "8080"
    SecurePrefs.getString(this, SecurePrefs.KEY_SERVER).ifBlank { null }?.let {
      pb.environment()["API_SERVER_KEY"] = it
    }
    // Registry providers (deepseek, openai-api...) resolve their key ONLY from env
    // (auth.py _resolve_api_key_provider_secret); providers.<name>.api_key in
    // YAML is dead for them. Export the user's key under the right env name.
    val provider = prefs.getString("provider_name", "deepseek").orEmpty().ifBlank { "deepseek" }
    SecurePrefs.getString(this, SecurePrefs.KEY_PROVIDER).ifBlank { null }?.let { key ->
      pb.environment()[providerKeyEnv(provider)] = key
    }
    // base_url is independent of the key: export whenever present and mapped.
    prefs.getString("provider_base_url", "").orEmpty().ifBlank { null }?.let { baseUrl ->
      providerBaseUrlEnv(provider)?.let { pb.environment()[it] = baseUrl }
    }
    SecurePrefs.getString(this, SecurePrefs.KEY_TG).ifBlank { null }?.let {
      pb.environment()["TELEGRAM_BOT_TOKEN"] = it
    }
    SecurePrefs.getString(this, SecurePrefs.KEY_DISCORD).ifBlank { null }?.let {
      pb.environment()["DISCORD_BOT_TOKEN"] = it
    }
    pb.redirectErrorStream(true)
    gatewayProc = pb.start()
    // Drain output to gateway.log off the main IO thread.
    val proc = gatewayProc ?: return
    val log = File(Bootstrap.rootDir(this), "gateway.log")
    logOut?.let { try { it.close() } catch (_: Exception) { } }
    val out = log.outputStream()
    logOut = out
    scope.launch(Dispatchers.IO) {
      try {
        proc.inputStream.copyTo(out)
      } catch (_: Exception) { }
    }
  }

  private suspend fun waitForListen(timeoutMs: Long): Boolean {
    val log = File(Bootstrap.rootDir(this), "gateway.log")
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
      if (!wantRun) return false
      try {
        if (log.exists()) {
          val tail = log.takeIf { it.length() < 200_000 }?.readText()
            ?: log.inputStream().use { it.skip(log.length() - 200_000); it.readBytes().toString(Charsets.UTF_8) }
          if (tail.contains("listening on http://127.0.0.1:8080") ||
            tail.contains("API server listening on http://127.0.0.1:8080")
          ) return true
        }
      } catch (_: Exception) { }
      // Primary signal: the /health endpoint answers. Log strings are a fallback.
      try {
        val c = URL("http://127.0.0.1:8080/health").openConnection() as HttpURLConnection
        c.connectTimeout = 2_000; c.readTimeout = 2_000
        if (c.responseCode in 200..299) return true
      } catch (_: Exception) { }
      delay(1_000)
    }
    return false
  }

  /**
   * Best-effort sweep of orphaned proot guest processes. Guests can outlive
   * the parent (proot is killed, guests keep port 8080 -> EADDRINUSE on next
   * start). Same-uid kill is permitted, so match our private files dir in
   * /proc cmdlines. Compile-safe: no java.lang.ProcessHandle (absent from
   * android.jar's java.lang.Process stub).
   */
  private fun sweepOrphanedGuests() {
    try {
      val marker = filesDir.absolutePath
      val self = android.os.Process.myPid()
      java.io.File("/proc").listFiles()?.forEach { dir ->
        val pid = dir.name.toIntOrNull() ?: return@forEach
        if (pid == self) return@forEach
        try {
          val cmd = java.io.File(dir, "cmdline").readBytes().toString(Charsets.UTF_8)
          if (cmd.contains(marker)) android.os.Process.killProcess(pid)
        } catch (_: Exception) { }
      }
    } catch (_: Exception) { }
  }

  private fun stopGateway() {
    val proc = gatewayProc
    gatewayProc = null
    if (proc == null) return
    try {
      // Kill guest descendants first: proot guest processes can outlive the
      // parent and keep holding port 8080 (EADDRINUSE on next start).
      sweepOrphanedGuests()
      proc.destroy() // SIGTERM
      if (!proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
        proc.destroyForcibly()
        proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
      }
    } catch (_: Exception) { } finally {
      try { proc.inputStream.close() } catch (_: Exception) { }
      try { proc.outputStream.close() } catch (_: Exception) { }
      try { proc.errorStream.close() } catch (_: Exception) { }
      logOut?.let { try { it.close() } catch (_: Exception) { } }
      logOut = null
    }
  }

  private fun appendLog(line: String) {
    try {
      val f = File(Bootstrap.rootDir(this), "service.log")
      f.appendText("${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())} $line\n")
    } catch (_: Exception) { }
  }

  companion object {
    /** Bounded WakeLock window: re-acquired by supervise() while still wanted. */
    private const val WAKE_TIMEOUT_MS = 10 * 60 * 1_000L
    /** Circuit breaker: stop auto-retry after this many consecutive failures. */
    private const val MAX_RESTARTS = 5

    /** True once the supervisor hit the circuit breaker; cleared on explicit Start. */
    val gatewayFailed = MutableStateFlow(false)
    /** Human-readable reason for gatewayFailed; null when not failed. */
    val gatewayFailureReason = MutableStateFlow<String?>(null)

    fun start(ctx: Context) {
      val i = Intent(ctx, MobileGatewayService::class.java).setAction("START")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
      else ctx.startService(i)
    }

    fun install(ctx: Context) {
      val i = Intent(ctx, MobileGatewayService::class.java).setAction("INSTALL")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
      else ctx.startService(i)
    }

    fun stop(ctx: Context) {
      ctx.startService(Intent(ctx, MobileGatewayService::class.java).setAction("STOP"))
    }

    /** Registry provider id -> key env var (mirrors hermes_cli/auth.py rows). */
    fun providerKeyEnv(provider: String): String = when (normProvider(provider)) {
      "deepseek" -> "DEEPSEEK_API_KEY"
      "openai-api" -> "OPENAI_API_KEY"
      "anthropic" -> "ANTHROPIC_API_KEY"
      "gemini" -> "GOOGLE_API_KEY"
      "opencode-go" -> "OPENCODE_GO_API_KEY"
      "opencode-zen" -> "OPENCODE_ZEN_API_KEY"
      "xai" -> "XAI_API_KEY"
      "kimi-coding" -> "KIMI_API_KEY"
      "kimi-coding-cn" -> "KIMI_CN_API_KEY"
      "zai", "glm" -> "GLM_API_KEY"
      "nvidia" -> "NVIDIA_API_KEY"
      "huggingface" -> "HF_TOKEN"
      "xiaomi" -> "XIAOMI_API_KEY"
      "kilocode" -> "KILOCODE_API_KEY"
      "ai-gateway" -> "AI_GATEWAY_API_KEY"
      "minimax" -> "MINIMAX_API_KEY"
      "minimax-cn" -> "MINIMAX_CN_API_KEY"
      "copilot" -> "COPILOT_GITHUB_TOKEN"
      "lmstudio" -> "LM_API_KEY"
      "alibaba" -> "DASHSCOPE_API_KEY"
      "alibaba-coding-plan" -> "ALIBABA_CODING_PLAN_API_KEY"
      "arcee" -> "ARCEEAI_API_KEY"
      "tencent-tokenhub" -> "TOKENHUB_API_KEY"
      "tencent-tokenplan" -> "TOKENPLAN_API_KEY"
      "ollama-cloud" -> "OLLAMA_API_KEY"
      "azure-foundry" -> "AZURE_FOUNDRY_API_KEY"
      else -> provider.uppercase().replace("-", "_").replace(" ", "_") + "_API_KEY"
    }

    private fun providerBaseUrlEnv(provider: String): String? = when (normProvider(provider)) {
      "deepseek" -> "DEEPSEEK_BASE_URL"
      "openai-api" -> "OPENAI_BASE_URL"
      "anthropic" -> "ANTHROPIC_BASE_URL"
      "gemini" -> "GEMINI_BASE_URL"
      "opencode-go" -> "OPENCODE_GO_BASE_URL"
      "opencode-zen" -> "OPENCODE_ZEN_BASE_URL"
      "xai" -> "XAI_BASE_URL"
      "kimi-coding" -> "KIMI_BASE_URL"
      "zai", "glm" -> "GLM_BASE_URL"
      "nvidia" -> "NVIDIA_BASE_URL"
      "huggingface" -> "HF_BASE_URL"
      "xiaomi" -> "XIAOMI_BASE_URL"
      "kilocode" -> "KILOCODE_BASE_URL"
      "ai-gateway" -> "AI_GATEWAY_BASE_URL"
      "minimax" -> "MINIMAX_BASE_URL"
      "minimax-cn" -> "MINIMAX_CN_BASE_URL"
      "copilot" -> "COPILOT_API_BASE_URL"
      "lmstudio" -> "LM_BASE_URL"
      "alibaba" -> "DASHSCOPE_BASE_URL"
      "alibaba-coding-plan" -> "ALIBABA_CODING_PLAN_BASE_URL"
      "arcee" -> "ARCEE_BASE_URL"
      "stepfun" -> "STEPFUN_BASE_URL"
      "gmi" -> "GMI_BASE_URL"
      "actual" -> "ACTUAL_BASE_URL"
      "tencent-tokenhub" -> "TOKENHUB_BASE_URL"
      "tencent-tokenplan" -> "TOKENPLAN_BASE_URL"
      "ollama-cloud" -> "OLLAMA_BASE_URL"
      "azure-foundry" -> "AZURE_FOUNDRY_BASE_URL"
      else -> null
    }
  }
}
