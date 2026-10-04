package ee.oversight.hermes.mobile.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.net.wifi.WifiManager
import ee.oversight.hermes.mobile.normProvider
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.annotation.RequiresApi
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import ee.oversight.hermes.mobile.install.ApiServerCorsPatch
import ee.oversight.hermes.mobile.install.ApiServerExtrasPatch
import ee.oversight.hermes.mobile.install.Bootstrap
import ee.oversight.hermes.mobile.install.shQuote
import ee.oversight.hermes.mobile.install.stableFailure
import ee.oversight.hermes.mobile.security.SecurePrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
  /**
   * Single gateway lifecycle machine (GATEWAY-03). The web UI derives every
   * button, spinner and label from this via HermesGatewayPlugin.status() +
   * gatewayState.ts; nothing else tracks gateway/install booleans.
   */
  enum class GatewayMachineState {
    UNINITIALIZED, CHECKING, NOT_INSTALLED, INSTALLING, INSTALLED,
    STARTING, RUNNING, STOPPING, STOPPED, DEGRADED, FAILED
  }

  /** Startup sub-phase for GATEWAY-04 reporting. */
  enum class StartupPhase {
    IDLE, RENDER_CONFIG, PROOT_CHECK, LAUNCH, WAIT_LISTEN, HEALTH_PROBE, READY
  }

  /** Verified-stop probe result (GATEWAY-05). */
  data class StopVerification(
    val processExited: Boolean,
    val portClosed: Boolean,
    val healthFalse: Boolean
  ) {
    val verified: Boolean get() = processExited && portClosed && healthFalse
  }

  // SupervisorJob: one failing child must not cancel this scope. Without it
  // a single escaping exception stops every later start/install/stop for the
  // whole process lifetime and they all silently do nothing.
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  @Volatile private var watchJob: Job? = null
  private var gatewayProc: Process? = null
  private var logOut: java.io.OutputStream? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var installWakeLock: PowerManager.WakeLock? = null
  @Volatile private var installJob: Job? = null
  /** startId of the INSTALL intent that owns runInstall(); see stopSelf(id). */
  @Volatile private var installStartId = 0
  @Volatile private var wantRun = false
  /** Start/stop generation: a deferred STOP teardown must not kill a newer START. */
  @Volatile private var startGen = 0
  /** Elapsed-realtime mark of the current healthy stretch start (0 = none). */
  @Volatile private var healthySince = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Nothing may escape here: an uncaught throw in onStartCommand kills the
    // whole process (gateway included) before the service ever runs. Every
    // failure is funneled through a stable token instead.
    return try {
      routeStart(intent, startId)
    } catch (t: Throwable) {
      val token = stableFailure(t, REASON_SERVICE_START_BLOCKED)
      logRaw(this, "onStartCommand failed: $token")
      failServiceStart(token, startId)
      START_NOT_STICKY
    }
  }

  /**
   * Body of onStartCommand, guarded by the wrapper above. startId is threaded
   * through every stopSelf() call: stopSelf() with no id stops the service
   * even when a newer start request is already queued, which is exactly how a
   * Stop+Start pair left the freshly launched supervisor cancelled by the
   * pending stop. stopSelf(id) only stops when no later request arrived.
   */
  private fun routeStart(intent: Intent?, startId: Int): Int {
    if (intent?.action == "STOP") {
      wantRun = false
      setMachineState(GatewayMachineState.STOPPING)
      setPhase(StartupPhase.IDLE)
      // Drop the supervisor BEFORE tearing the process down: it races
      // otherwise and can relaunch proot after stopGateway(), which leaves
      // port 8080 held and the verified-stop check failing. The handle is
      // cleared here too, otherwise a Start arriving while the old loop is
      // still winding down sees a stale non-null job and silently does nothing.
      watchJob?.cancel()
      watchJob = null
      // STOP must also drop an in-flight install: otherwise the service is
      // demoted to background while the 305MB download + unpack still runs,
      // and LMK kills it mid-write leaving a corrupt rootfs.
      installJob?.cancel()
      installJob = null
      // stopGateway() blocks up to ~10s (SIGTERM wait + forced kill + orphan
      // sweep) and onStartCommand runs on the main thread: doing it inline
      // here is an ANR. The teardown runs on the service scope instead; the
      // plugin's verified-stop poll already waits for the outcome async.
      // Generation-guarded: a START arriving before this coroutine runs bumps
      // startGen, and this stale STOP then exits without touching the fresh
      // process or stripping its foreground notification.
      startGen++
      val sid = startId
      val gen = startGen
      scope.launch {
        if (gen != startGen) return@launch
        try { stopGateway() } catch (_: Exception) { }
        if (gen != startGen) return@launch
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) { }
        // STOPPED comes from markStoppedVerified() after the plugin verifies
        // process exit + port closed + health false (GATEWAY-05). onDestroy
        // settles it if the plugin never confirms.
        try { stopSelf(sid) } catch (_: Exception) { }
      }
      return START_NOT_STICKY
    }
    if (intent?.action == "INSTALL") {
      // One-shot image install inside the foreground service: FGS state
      // exempts the process from Doze/freezer kills when the screen sleeps.
      if (!enterForeground("Installing Hermes image", "downloading, do not close the app")) {
        // The plugin tails install.done; without this it would spin forever.
        markInstallRefused(startupLastError.value ?: REASON_SERVICE_START_BLOCKED, startId)
        return START_NOT_STICKY
      }
      // Newest startId owns stopSelf(): refresh on EVERY INSTALL intent, not
      // only when a job is launched. A second INSTALL arriving mid-install
      // left a stale id behind, stopSelf(staleId) was then refused by the
      // framework, and the service outlived its own notification.
      installStartId = startId
      if (installJob?.isActive != true) {
        // Remembered so runInstall()'s finally stops THIS intent only: a
        // Start that lands while the install is finishing must keep its
        // foreground service (and its notification) alive.
        val job = scope.launch { runInstall() }
        installJob = job
        job.invokeOnCompletion { if (installJob === job) installJob = null }
      }
      return START_STICKY
    }
    if (!enterForeground("Hermes Mobile running", "on-phone gateway on localhost:8080")) {
      failServiceStart(startupLastError.value ?: REASON_SERVICE_START_BLOCKED, startId)
      return START_NOT_STICKY
    }
    if (watchJob?.isActive == true) {
      // An existing supervisor is already running; cancel it so this fresh Start takes over.
      watchJob?.cancel()
    }
    everStarted = true
    startGen++
    noteStart()
    setMachineState(GatewayMachineState.CHECKING)
    setPhase(StartupPhase.RENDER_CONFIG)
    if (!Bootstrap.isInstalled(this)) {
      setMachineState(GatewayMachineState.NOT_INSTALLED)
      startupLastError.value = "not_installed: run install() first"
      gatewayFailed.value = false
      gatewayFailureReason.value = null
      wantRun = false
      try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) { }
      stopSelf(startId)
      return START_NOT_STICKY
    }
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
      try { wakeLock?.setReferenceCounted(false) } catch (_: Exception) { }
    }
    try { wakeLock?.acquire(WAKE_TIMEOUT_MS) } catch (_: Exception) { }
    val job = scope.launch { supervise() }
    watchJob = job
    // Clear only our own handle: a later Start may already have replaced it.
    job.invokeOnCompletion { if (watchJob === job) watchJob = null }
    return START_STICKY
  }

  /** startForeground() can be refused by the platform; never let it throw. */
  private fun enterForeground(title: String, text: String): Boolean = try {
    startForegroundInternal(title, text)
    true
  } catch (e: Exception) {
    val token = stableFailure(e, REASON_SERVICE_START_BLOCKED)
    logRaw(this, "foreground start refused: $token")
    startupLastError.value = token
    false
  }

  /** Terminal service-start refusal: stable token only, then stand down. */
  private fun failServiceStart(token: String, startId: Int) {
    wantRun = false
    startupLastError.value = token
    setPhase(StartupPhase.IDLE)
    setMachineState(GatewayMachineState.FAILED)
    try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) { }
    try { stopSelf(startId) } catch (_: Exception) { }
  }

  /**
   * The install notification could not be shown. install.done must still be
   * written or HermesGatewayPlugin.install() polls a file that never appears
   * and the wizard hangs with no error.
   */
  private fun markInstallRefused(token: String, startId: Int) {
    startupLastError.value = token
    setMachineState(GatewayMachineState.NOT_INSTALLED)
    try {
      val root = Bootstrap.rootDir(this)
      root.mkdirs()
      writeDone(File(root, "install.done"), "error: $token")
    } catch (_: Exception) { }
    try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) { }
    try { stopSelf(startId) } catch (_: Exception) { }
  }

  /**
   * install.done is polled as one whole verdict by HermesGatewayPlugin, and
   * writeText() is not atomic: a reader can catch half a sentence ("o",
   * "error: inst") and render it as the install error. Write a side file and
   * rename it over the target, so the file either does not exist or holds the
   * complete verdict.
   */
  private fun writeDone(done: File, text: String) {
    try {
      val tmp = File(done.parentFile, "install.done.tmp")
      tmp.writeText(text)
      if (tmp.renameTo(done)) return
    } catch (_: Exception) { }
    try { done.writeText(text) } catch (_: Exception) { }
  }

  /**
   * Android 15+ FGS timeout (R2). dataSync has a ~6h daily budget; if the
   * system times out our registration it kills the service silently, leaving
   * the UI showing "running" against a dead process. Mark FAILED with a
   * named token, enqueue a BootWorker one-shot so the restart path is real
   * (BootWorker re-checks the autostart pref), then stop cleanly.
   */
  @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
  override fun onTimeout(startId: Int) {
    onFgsTimeout(startId, -1)
  }

  @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  override fun onTimeout(startId: Int, fgsType: Int) {
    onFgsTimeout(startId, fgsType)
  }

  private fun onFgsTimeout(startId: Int, fgsType: Int) {
    appendLog("gateway foreground service timed out (type $fgsType); marking FAILED and stopping so it can restart later")
    wantRun = false
    try {
      startupLastError.value = "fgs_timeout"
      setMachineState(GatewayMachineState.FAILED)
    } catch (_: Exception) { }
    try {
      val prefs = getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      val now = System.currentTimeMillis()
      val lastMs = prefs.getLong("fgs_timeout_last_ms", 0L)
      val count = prefs.getInt("fgs_timeout_count", 0)
      val nextCount = if (now - lastMs > 24 * 60 * 60 * 1000L) 1 else count + 1
      prefs.edit().putLong("fgs_timeout_last_ms", now).putInt("fgs_timeout_count", nextCount).apply()
      val delayMs = (15 * 60 * 1000L * (1L shl (nextCount - 1).coerceAtMost(4))).coerceAtMost(2 * 60 * 60 * 1000L)
      val withinBudget = now - lastMs > 6 * 60 * 60 * 1000L || nextCount < 4
      if (!withinBudget) {
        appendLog("fgs timeout: 6h budget exhausted, not rescheduling BootWorker (attempt $nextCount)")
      } else {
        val req = androidx.work.OneTimeWorkRequestBuilder<BootWorker>()
          .setInitialDelay(delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
          .build()
        androidx.work.WorkManager.getInstance(this).enqueue(req)
        appendLog("fgs timeout: BootWorker enqueued with ${delayMs / 60000} min backoff (attempt $nextCount)")
      }
    } catch (_: Exception) { }
    // Unconditional: with a specific startId the stop is refused when newer
    // intents queued, and Android 15 then crashes us for missing the window.
    try { stopSelf() } catch (_: Exception) { }
  }

  override fun onDestroy() {
    // Same rule as onStartCommand: nothing escapes into the main thread.
    try {
      wantRun = false
      watchJob?.cancel()
      watchJob = null
      installJob?.cancel()
      installJob = null
      // Cancel the scope itself too: the gateway log-drain coroutine (and any
      // job not individually cancelled) is a child of it, and the SupervisorJob
      // is never otherwise released, so children could outlive the service.
      scope.cancel()
      // stopGateway() blocks up to ~10s (SIGTERM wait + forced kill + orphan
      // sweep): on the main thread that is an ANR. Run it on a daemon thread
      // with a bounded join instead.
      val killer = Thread { try { stopGateway() } catch (_: Throwable) { } }
      killer.isDaemon = true
      killer.start()
      try { killer.join(3_000L) } catch (_: Exception) { }
      if (gatewayState.value == GatewayMachineState.STOPPING)
        setMachineState(GatewayMachineState.STOPPED)
      try { wakeLock?.release() } catch (_: Exception) { }
      wakeLock = null
      try { installWakeLock?.release() } catch (_: Exception) { }
      installWakeLock = null
    } catch (t: Throwable) {
      logRaw(this, "onDestroy failed: ${stableFailure(t, REASON_SERVICE_START_BLOCKED)}")
    }
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
    // Tap to reopen the app: without a content intent the notification is a
    // dead end and the only way back is the launcher. setOngoing keeps the
    // foreground notification in place, which is what users expect of an
    // "always on" gateway (swiping it away would leave the service running
    // with no visible entry). The FGS notification itself is exempt from
    // POST_NOTIFICATIONS; that permission (R1) covers the separate alert
    // channel and is requested once from MainActivity.
    val launch = PendingIntent.getActivity(
      this, 0,
      Intent(this, ee.oversight.hermes.mobile.MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE
    )
    val n: Notification = NotificationCompat.Builder(this, "gateway")
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setOngoing(true)
      .setContentIntent(launch)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // dataSync only (Play review: specialUse needs a strong justification).
      // The manifest declares dataSync, so the runtime type always matches.
      startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
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
    // Cleanup on EVERY exit path. superviseLoop() rethrows CancellationException
    // when Stop/destroy cancels it, which skipped the trailing stopGateway():
    // a proot spawned in that window survived with its guests, holding port
    // 8080, so the next Start could not bind and Stop could not free the port.
    // Tracking launchedProc ensures that this supervisor only tears down the
    // process it started, avoiding killing a newer supervisor's gateway.
    var launchedProc: Process? = null
    try {
      superviseLoop { p -> launchedProc = p }
    } finally {
      stopGateway(launchedProc)
      // Normal-stop path: onDestroy releases too, but if the service object
      // outlives supervise (sticky restart, pending intents) the 10-minute
      // lock would burn battery. Release here as well.
      try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) { }
    }
  }

  private suspend fun superviseLoop(onProcessStarted: (Process) -> Unit) {
    // Installations from older APKs never got the streaming CORS header, so the
    // WebView blocked every streamed reply even though curl was fine. Applied
    // once per session before the first launch; idempotent and never fatal.
    try {
      val cors = ApiServerCorsPatch.apply(Bootstrap.rootfsDir(this)) { f -> guestCompile(f) }
      if (cors == ApiServerCorsPatch.Outcome.APPLIED) appendLog("sse cors patch applied")
      val extras = applyMobileExtrasPatch()
      if (extras == ApiServerExtrasPatch.Outcome.APPLIED) appendLog("mobile extras patch applied")
    } catch (_: Exception) { }
    var backoff = START_BACKOFF_MS
    var failures = 0
    var activeProc: Process? = null
    while (wantRun) {
      ensureWake()
      try {
        setMachineState(GatewayMachineState.STARTING)
        setPhase(StartupPhase.RENDER_CONFIG)
        Bootstrap.renderConfig(this@MobileGatewayService)
        // Structured boot trace (presence only, never the secret itself):
        // with these lines the log alone tells SERVER_KEY vs START vs HEALTH.
        appendLog("[GATEWAY] stage=SERVER_KEY present=${SecurePrefs.getString(this@MobileGatewayService, SecurePrefs.KEY_SERVER).isNotBlank()}")
        setPhase(StartupPhase.PROOT_CHECK)
        val proc = startGateway()
        activeProc = proc
        onProcessStarted(proc)
        // Wait for the listen line, then monitor the process. The backoff is
        // deliberately NOT reset here: resetting it before the attempt threw
        // away every doubling below, so the loop hammered a broken start
        // every 5s instead of backing off toward MAX_RESTARTS.
        setPhase(StartupPhase.WAIT_LISTEN)
        val up = waitForListen(LISTEN_TIMEOUT_MS)
        if (!wantRun) break
        if (!up) {
          failures++
          if (gatewayState.value != GatewayMachineState.FAILED)
            setMachineState(GatewayMachineState.DEGRADED)
          appendLog("[GATEWAY][ERROR] stage=WAIT_LISTEN code=LISTEN_TIMEOUT (attempt $failures/$MAX_RESTARTS)")
          if (failures >= MAX_RESTARTS) {
            // Reason, not log advice: plainFailure.ts masks any reason that
            // names a file ("... see gateway.log") to a generic sentence, so
            // the specific failure never reaches the screen.
            failSupervisor(REASON_GATEWAY_START_TIMEOUT, activeProc)
            break
          }
        } else {
          // waitForListen() answers from /health, so the probe phase belongs
          // after the wait, not before it (it used to overwrite WAIT_LISTEN
          // the instant the wait began, so the UI never showed the wait).
          setPhase(StartupPhase.HEALTH_PROBE)
          appendLog("gateway listening on 127.0.0.1:8080")
          // Stability-gated reset: a crash right after listen must NOT clear
          // the counter, or a crash-after-listen loop spins forever without
          // ever tripping the breaker. healthySince marks this stretch start.
          healthySince = SystemClock.elapsedRealtime()
          backoff = START_BACKOFF_MS
          setPhase(StartupPhase.READY)
          appendLog("[GATEWAY] stage=READY code=HEALTH_OK")
          setMachineState(GatewayMachineState.RUNNING)
          while (wantRun && gatewayProc?.isAlive == true) {
            ensureWake()
            delay(PROCESS_POLL_MS)
          }
          if (!wantRun) break
          // Reset the breaker only after a proven-stable stretch (60s+ of
          // healthy running). Anything shorter counts toward MAX_RESTARTS.
          if (healthySince > 0L && SystemClock.elapsedRealtime() - healthySince >= STABLE_RESET_MS) {
            failures = 0
          }
          healthySince = 0L
          failures++
          setMachineState(GatewayMachineState.DEGRADED)
          appendLog("gateway exited, restarting... (attempt $failures/$MAX_RESTARTS)")
          if (failures >= MAX_RESTARTS) {
            // Bare token, not "keeps exiting (N attempts), see gateway.log":
            // the mapper treats any sentence naming a log file as machine
            // noise and replaces it with one generic message.
            failSupervisor(REASON_PROCESS_EXITS, activeProc)
            break
          }
        }
      } catch (c: CancellationException) {
        // Stop/destroy cancels us: that is not a gateway failure, so never
        // let it trip the circuit breaker or paint FAILED over STOPPED.
        throw c
      } catch (t: Throwable) {
        failures++
        // Raw detail stays in service.log (diagnostics); the UI gets a token.
        appendLog("gateway supervisor cause: ${t.javaClass.simpleName}: ${t.message}")
        val token = stableFailure(t, REASON_START_FAILED)
        appendLog("gateway supervisor: $token (attempt $failures/$MAX_RESTARTS)")
        if (failures >= MAX_RESTARTS) {
          failSupervisor(token, activeProc)
          break
        }
      }
      stopGateway(activeProc)
      activeProc = null
      if (!wantRun) break
      delay(backoff)
      backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
    }
    stopGateway(activeProc)
  }

  /** Circuit breaker: mark FAILED and stop auto-retry until explicit Start. */
  private fun failSupervisor(reason: String, procToStop: Process? = null) {
    stopGateway(procToStop)
    gatewayFailureReason.value = reason
    gatewayFailed.value = true
    startupLastError.value = reason
    setPhase(StartupPhase.IDLE)
    setMachineState(GatewayMachineState.FAILED)
    appendLog("gateway FAILED: $reason")
    try { wakeLock?.release() } catch (_: Exception) { }
  }

  /**
   * Compile probe handed to ApiServerCorsPatch before it swaps api_server.py.
   *
   * The phone ships no python, the image has two, and the candidate only
   * exists inside the rootfs, so the check runs through proot on the GUEST
   * path (host paths are meaningless to the interpreter). It calls compile()
   * rather than py_compile so the probe writes nothing into the image, and any
   * doubt (no proot, no interpreter, non-zero exit, timeout) reports false:
   * the patch is aborted and the pristine file stays in place, which costs the
   * streaming CORS header but never a gateway that cannot parse its own file.
   */
  private fun guestCompile(candidate: File): Boolean {
    val guest = ApiServerCorsPatch.guestPath(Bootstrap.rootfsDir(this), candidate) ?: return false
    // Double quotes only, so the whole probe sits inside one pair of single
    // quotes for /bin/sh and never splits the command line.
    val probe = "import sys;compile(open(sys.argv[1],\"rb\").read(),sys.argv[1],\"exec\")"
    for (py in listOf("/opt/python314/python/bin/python3.14", "/usr/bin/python3")) {
      val code = try {
        Bootstrap.runProot(
          this,
          "$py -c ${shQuote(probe)} ${shQuote(guest)}",
          SYNTAX_CHECK_TIMEOUT_MS,
          logFile = File(Bootstrap.rootDir(this), "corsfix_check.log")
        )
      } catch (_: Exception) { 1 }
      if (code == 0) return true
    }
    return false
  }

  /**
   * Mobile extras module text comes from APK assets (pinned copy of
   * device-patch/api_server_mobile_extras.py), so a fresh install carries
   * the memory/blueprint/validate/project routes with no extra download.
   * Never throws: any miss reports ABORTED and the install stays as found.
   */
  private fun applyMobileExtrasPatch(): ApiServerExtrasPatch.Outcome {
    val source = try {
      assets.open(ApiServerExtrasPatch.ASSET_NAME).readBytes().toString(Charsets.UTF_8)
    } catch (_: Exception) {
      return ApiServerExtrasPatch.Outcome.ABORTED
    }
    if (source.isBlank()) return ApiServerExtrasPatch.Outcome.ABORTED
    return try {
      ApiServerExtrasPatch.apply(Bootstrap.rootfsDir(this), source) { f -> guestCompile(f) }
    } catch (_: Exception) {
      ApiServerExtrasPatch.Outcome.ABORTED
    }
  }

  /** One-shot image install. Runs under FGS so screen-off cannot kill it. */
  private suspend fun runInstall() {
    val root = Bootstrap.rootDir(this)
    val log = File(root, "install.log")
    val done = File(root, "install.done")
    var wifiLock: WifiManager.WifiLock? = null
    // The whole body is guarded, not just the download: anything above the
    // old inner try (system-service lookup, lock acquisition, file prep) that
    // escaped cancelled the service scope for good AND left install.done
    // unwritten, so the plugin's tail loop spun forever with no error.
    try {
      setMachineState(GatewayMachineState.INSTALLING)
      noteStart()
      try { root.mkdirs() } catch (_: Exception) { }
      try { done.delete() } catch (_: Exception) { }
      try { log.delete() } catch (_: Exception) { }
      // as? not as: a device with no Wi-Fi service returns null and the cast
      // used to throw before the guard, taking the whole install with it.
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      wifiLock = try {
        wifi?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hermes:install")
      } catch (_: Exception) { null }
      // Same: WifiLock.acquire() takes no timeout; the matching release in
      // the guarded finally below is what bounds the hold.
      try { wifiLock?.acquire() } catch (_: Exception) { }
      // Own lock field: the gateway's 10-minute hermes:gateway lock and the
      // installer's 45-minute window used to share one field, so whichever
      // ran last silently re-timed and then released the other's lock.
      if (installWakeLock == null) {
        installWakeLock = try {
          (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hermes:install")
        } catch (_: Exception) { null }
      }
      try { installWakeLock?.acquire(INSTALL_WAKE_MS) } catch (_: Exception) { }
      try {
        Bootstrap.install(this@MobileGatewayService) { line ->
          try { log.appendText(line + "\n") } catch (_: Exception) { }
        }
        // The shipped image has no CORS header on its streaming responses, and
        // the WebView refuses them, so patch the two prepare() sites here.
        // Non fatal: a future image with a different shape is left untouched.
        val cors = ApiServerCorsPatch.apply(Bootstrap.rootfsDir(this)) { f -> guestCompile(f) }
        try { log.appendText("sse cors patch: ${cors.name.lowercase()}\n") } catch (_: Exception) { }
        // The prebuilt image predates the memory/blueprint/validate/project
        // routes the app calls; install them now so a fresh phone heals
        // itself. Non fatal, same contract as the CORS patch above.
        val extras = applyMobileExtrasPatch()
        try { log.appendText("mobile extras patch: ${extras.name.lowercase()}\n") } catch (_: Exception) { }
        writeDone(done, "ok")
        setMachineState(GatewayMachineState.INSTALLED)
      } catch (t: Throwable) {
        // install.log keeps the raw detail for the wizard classifier; the app
        // layer only ever sees our curated copy or a stable plain token.
        val token = stableFailure(t, REASON_INSTALL_FAILED)
        try { log.appendText("FAILED: $token\n") } catch (_: Exception) { }
        try { log.appendText("cause: ${t.javaClass.simpleName}: ${t.message}\n") } catch (_: Exception) { }
        writeDone(done, "error: $token")
        startupLastError.value = token
        setMachineState(GatewayMachineState.NOT_INSTALLED)
      }
    } catch (t: Throwable) {
      val token = stableFailure(t, REASON_INSTALL_FAILED)
      try { log.appendText("FAILED: $token\n") } catch (_: Exception) { }
      try { log.appendText("cause: ${t.javaClass.simpleName}: ${t.message}\n") } catch (_: Exception) { }
      writeDone(done, "error: $token")
      startupLastError.value = token
      setMachineState(GatewayMachineState.NOT_INSTALLED)
    } finally {
      try { if (wifiLock?.isHeld == true) wifiLock?.release() } catch (_: Exception) { }
      try { if (installWakeLock?.isHeld == true) installWakeLock?.release() } catch (_: Exception) { }
      installWakeLock = null
      // Back to a plain background state; an explicit Start re-enters FGS.
      // Both are conditional: install.done is readable the instant it is
      // written, so the wizard's Start can already have arrived (wantRun) or
      // be queued behind this intent (stopSelf(startId) refuses to stop).
      // Tearing the foreground state down here would strip the notification
      // of a gateway that is about to run, or kill the supervisor it just
      // launched.
      if (!wantRun) {
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) { }
      }
      val id = installStartId
      try { if (id > 0) stopSelf(id) else stopSelf() } catch (_: Exception) { }
    }
  }

  private fun startGateway(): Process {
    stopGateway()
    // Validate the argv inputs before building: ProcessBuilder itself never
    // reports a missing binary until pb.start(), where the message is raw
    // platform text. Same checks Bootstrap.runProot() makes.
    val prootBin = Bootstrap.prootFile(this)
    require(prootBin.exists()) {
      "proot binary missing at ${prootBin.absolutePath} (reinstall the app)"
    }
    require(prootBin.canExecute()) {
      "proot at ${prootBin.absolutePath} is not executable (SELinux exec denial? reinstall the app)"
    }
    val fsDir = Bootstrap.rootfsDir(this)
    require(fsDir.isDirectory) {
      "rootfs missing at ${fsDir.absolutePath} (run install() first)"
    }
    val proot = prootBin.absolutePath
    val fs = fsDir.absolutePath
    val home = Bootstrap.hermesHome(this).absolutePath
    val cfg = File(Bootstrap.rootDir(this), "config.yaml").absolutePath
    val pb = ProcessBuilder(
      proot, "-r", fs,
      "-b", "/dev", "-b", "/proc", "-b", "/sys",
      // Projects: user folders on /storage must resolve inside the guest or
      // project symlinks dangle. No restart to switch: binds are fixed at
      // launch, per-project links are created live under /root/.projects.
      "-b", "/storage", "-b", "/sdcard",
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
    pb.environment()["LD_LIBRARY_PATH"] = File(Bootstrap.prootLibDir(this), "lib").absolutePath
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
    // The WebView app is served from https://localhost, so every browser fetch
    // to the gateway is cross-origin and preflights. Without an explicit
    // allow-list the api_server answers no ACAO header and the WebView blocks
    // everything (UI stuck Offline, streams fail). Loopback-only anyway.
    pb.environment()["API_SERVER_CORS_ORIGINS"] = "https://localhost,capacitor://localhost"
    // Re-read the STORED value instead of trusting the one renderConfig()
    // handed back: if that write was rejected (SecurePrefs fallback, crypto
    // failure) the in-memory key looks fine while nothing was persisted, and
    // 0.21.x would then start without API_SERVER_KEY. The browser calls 401 on
    // every request and the WebView blames the user's key forever, so fail the
    // start instead: supervisor + status() get a reason they can show.
    val serverKey = SecurePrefs.getString(this, SecurePrefs.KEY_SERVER)
    require(serverKey.isNotBlank()) {
      "API_SERVER_KEY missing: the server key was not stored" +
        (SecurePrefs.lastError()?.let { " ($it)" } ?: "")
    }
    pb.environment()["API_SERVER_KEY"] = serverKey
    // Registry providers (deepseek, openai-api...) resolve their key ONLY from env
    // (auth.py _resolve_api_key_provider_secret); providers.<name>.api_key in
    // YAML is dead for them. Export the user's key under the right env name.
    val provider = prefs.getString("provider_name", "deepseek").orEmpty().ifBlank { "deepseek" }
    // The active profile id lets the service fall back to the profile's own
    // slot: some save paths land only there (the WebView writes per-profile
    // secrets directly), and a gateway that sees neither key boots live but
    // answers nothing, which reads as 'not replying' with no visible cause.
    val activeProfileId = prefs.getString("provider_profile_id", "").orEmpty()
    val providerKey = SecurePrefs.getString(this, SecurePrefs.KEY_PROVIDER).orEmpty()
      .ifBlank {
        if (activeProfileId.isNotBlank()) {
          SecurePrefs.getString(this, "provider.${activeProfileId}.apiKey", "")
        } else {
          ""
        }
      }
      .ifBlank {
        // Last resort: the legacy per-provider slug slot (setProvider
        // dual-writes every non-blank key there). A gateway that sees no key
        // boots live but answers nothing, so try the slug before giving up.
        if (Regex("^[A-Za-z0-9_-]{1,64}$").matches(provider)) {
          SecurePrefs.getString(this, "provider.${provider}.apiKey", "")
        } else {
          ""
        }
      }
    if (providerKey.isNotBlank()) {
      pb.environment()[providerKeyEnv(provider)] = providerKey
      appendLog("provider key exported for $provider (${providerKeyEnv(provider)})")
    } else {
      appendLog("no provider key stored for $provider, the gateway will start without credentials")
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
    // pb.start() failure publishes nothing (gatewayProc/processAlive stay
    // false) and the supervisor maps the raw IOException to a token.
    val proc = pb.start()
    // Publish immediately: every later step must be cleanable by
    // stopGateway(), or a half-started proot keeps port 8080 held forever.
    gatewayProc = proc
    processAlive = true
    // Drain output to gateway.log off the main IO thread. The log dir is
    // created first: a missing debian/ used to throw here after the process
    // was already running.
    val log = File(Bootstrap.rootDir(this), "gateway.log")
    log.parentFile?.mkdirs()
    rotateLogIfLarge(log, MAX_LOG_BYTES, KEEP_LOG_BYTES)
    logOut?.let { try { it.close() } catch (_: Exception) { } }
    val out = log.outputStream()
    logOut = out
    scope.launch(Dispatchers.IO) {
      try {
        proc.inputStream.copyTo(out)
      } catch (_: Exception) { }
    }
    return proc
  }

  private suspend fun waitForListen(timeoutMs: Long): Boolean {
    val log = File(Bootstrap.rootDir(this), "gateway.log")
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
      if (!wantRun) return false
      // Process-liveness gate: a dead proot answers no health probe and
      // writes no listen line, so waiting out the full timeout only delays
      // the supervisor's restart/backoff accounting.
      val p = gatewayProc
      if (p != null && !p.isAlive) return false
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
        val c = URL("http://127.0.0.1:8080/health").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
        c.setRequestProperty("Connection", "close")
        c.connectTimeout = 2_000; c.readTimeout = 2_000
        val code = c.responseCode
        c.disconnect()
        if (code in 200..299) return true
      } catch (_: Exception) { }
      delay(1_000)
    }
    return false
  }

  /**
   * Best-effort sweep of orphaned proot guest processes. Guests can outlive
   * the parent (proot is killed, guests keep port 8080 -> EADDRINUSE on next
   * start). Same-uid kill is permitted, so match our private files dir or
   * guest Python runtime signatures in /proc cmdlines. Compile-safe: no
   * java.lang.ProcessHandle (absent from android.jar's java.lang.Process stub).
   */
  private fun sweepOrphanedGuests() {
    try {
      var kills = 0
      val marker = filesDir.absolutePath
      val self = android.os.Process.myPid()
      java.io.File("/proc").listFiles()?.forEach { dir ->
        val pid = dir.name.toIntOrNull() ?: return@forEach
        if (pid == self) return@forEach
        try {
          val cmd = java.io.File(dir, "cmdline").readBytes().toString(Charsets.UTF_8)
          if (cmd.contains(marker) ||
            cmd.contains("hermes_cli") ||
            cmd.contains("hermes-agent") ||
            cmd.contains("/opt/python314")
          ) {
            android.os.Process.killProcess(pid)
            kills++
          }
        } catch (_: Exception) { }
      }
      if (kills > 0) appendLog("orphan sweep killed $kills")
    } catch (_: Exception) { }
  }

  private fun stopGateway(onlyProc: Process? = null) {
    val proc = gatewayProc
    if (onlyProc != null && proc !== onlyProc) {
      // The current process is not the one this supervisor launched; do not kill it.
      return
    }
    gatewayProc = null
    if (proc == null) {
      // Still sweep. After the app process is killed the service comes back
      // with no tracked Process while the old proot guests survive on port
      // 8080; returning here left them unreachable: the next Start could not
      // bind (5 failed attempts -> FAILED) and Stop could not free the port,
      // so verifyStopped() reported portClosed=false forever.
      sweepOrphanedGuests()
      processAlive = false
      return
    }
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
      // Sweep again after proot destruction: any child process that was reparented
      // to init when proot died must be cleaned up now so port 8080 is freed immediately.
      sweepOrphanedGuests()
      processAlive = false
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
      rotateLogIfLarge(f, MAX_LOG_BYTES, KEEP_LOG_BYTES)
      f.appendText("${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())} $line\n")
    } catch (_: Exception) { }
  }

  /** Log rotation: an always-on gateway would otherwise fill storage.
   *  Keeps the newest KEEP bytes once the file passes MAX bytes. */
  private fun rotateLogIfLarge(f: File, max: Long, keep: Long) =
    Companion.rotateLogFile(f, max, keep)

  companion object {
    /** Bounded WakeLock window: re-acquired by supervise() while still wanted. */
    private const val WAKE_TIMEOUT_MS = 10 * 60 * 1_000L
    /** Log cap: rotate gateway.log/service.log past 1MB, keep newest 256KB. */
    private const val MAX_LOG_BYTES = 1 * 1024 * 1024L
    private const val KEEP_LOG_BYTES = 256 * 1024L
    /** Installer window: the image download+extract legitimately outlives the
     *  gateway window, so it gets its own lock instead of re-timing that one. */
    private const val INSTALL_WAKE_MS = 45 * 60 * 1_000L
    /** Circuit breaker: stop auto-retry after this many consecutive failures. */
    private const val MAX_RESTARTS = 5
    /** Healthy stretch required before the restart breaker resets (60s). */
    private const val STABLE_RESET_MS = 60_000L
    /** First restart gap; doubles per failure up to [MAX_BACKOFF_MS]. */
    private const val START_BACKOFF_MS = 5_000L
    private const val MAX_BACKOFF_MS = 60_000L
    /** Wall-clock budget for one listen attempt (log line + /health probe). */
    private const val LISTEN_TIMEOUT_MS = 180_000L
    /** Process-liveness poll while RUNNING. */
    private const val PROCESS_POLL_MS = 5_000L
    /**
     * Stable machine token for a platform-refused service start. Android's own
     * exception text ("startForegroundService() not allowed due…", "Not
     * allowed to start service Intent… app is in background") is never
     * surfaced; screens map this token to plain copy.
     */
    private const val REASON_SERVICE_START_BLOCKED = "service_start_blocked"
    /** Stable token for a gateway launch that failed before it was reachable. */
    private const val REASON_START_FAILED = "start_failed"
    /** Stable token for an install that failed without its own curated copy. */
    private const val REASON_INSTALL_FAILED = "install_failed"
    /**
     * Supervisor reasons are consumed by src/services/plainFailure.ts, which
     * classifies a reason as machine text and replaces anything carrying a
     * log filename or a sentence with generic copy. Emitting these as bare
     * tokens (the shape TOKEN_RE expects) is what lets the web layer tell the
     * two terminal failures apart instead of showing one vague sentence.
     */
    private const val REASON_GATEWAY_START_TIMEOUT = "gateway_start_timeout"
    private const val REASON_PROCESS_EXITS = "process_exits"
    /** Budget for the in-guest compile probe before the CORS patch swaps a file. */
    private const val SYNTAX_CHECK_TIMEOUT_MS = 30_000L

    /** True once the supervisor hit the circuit breaker; cleared on explicit Start. */
    val gatewayFailed = MutableStateFlow(false)
    /** Human-readable reason for gatewayFailed; null when not failed. */
    val gatewayFailureReason = MutableStateFlow<String?>(null)

    /** Single lifecycle machine (GATEWAY-03): all UI derives from this. */
    val gatewayState = MutableStateFlow(GatewayMachineState.UNINITIALIZED)
    /** Startup sub-phase (GATEWAY-04): where a STARTING gateway is. */
    val startupPhase = MutableStateFlow(StartupPhase.IDLE)
    /** Uptime basis for phase/elapsed reporting; 0 = never started. */
    val startupStartedAt = MutableStateFlow(0L)
    /** Last error for FAILED / failed install; null when healthy. */
    val startupLastError = MutableStateFlow<String?>(null)
    /** True once a START intent arrived this boot (INSTALLED vs STOPPED). */
    @Volatile var everStarted = false
    /** Mirrors gatewayProc liveness for the verified-stop check (GATEWAY-05). */
    @Volatile var processAlive = false

    fun setMachineState(s: GatewayMachineState) { gatewayState.value = s }
    fun setPhase(p: StartupPhase) { startupPhase.value = p }
    fun noteStart() {
      startupStartedAt.value = System.currentTimeMillis()
      startupLastError.value = null
      // A new attempt starts from scratch: without this an install (which
      // never sets a phase of its own) kept reporting the previous run's
      // READY/HEALTH_PROBE in status(), and a service destroyed while running
      // left it there across restarts.
      startupPhase.value = StartupPhase.IDLE
    }
    fun elapsedMs(): Long {
      val t = startupStartedAt.value
      return if (t == 0L) 0L else System.currentTimeMillis() - t
    }

    /**
     * Verified-stop probe (GATEWAY-05): process exit + port closed + health
     * false. Called by HermesGatewayPlugin after the STOP intent; the UI may
     * show STOPPED only when [StopVerification.verified] is true.
     */
    fun verifyStopped(): StopVerification {
      val procGone = !processAlive
      var portClosed = false
      try {
        java.net.Socket().use { s ->
          s.connect(java.net.InetSocketAddress("127.0.0.1", 8080), 1_500)
        }
        portClosed = false
      } catch (_: Exception) {
        portClosed = true
      }
      var healthFalse = false
      try {
        val c = java.net.URL("http://127.0.0.1:8080/health").openConnection(java.net.Proxy.NO_PROXY)
          as java.net.HttpURLConnection
        c.setRequestProperty("Connection", "close")
        c.connectTimeout = 1_500
        c.readTimeout = 1_500
        healthFalse = c.responseCode !in 200..299
        c.disconnect()
      } catch (_: Exception) {
        healthFalse = true
      }
      return StopVerification(procGone, portClosed, healthFalse)
    }

    /** Plugin calls this only after verifyStopped() reports verified. */
    fun markStoppedVerified() {
      setPhase(StartupPhase.IDLE)
      setMachineState(GatewayMachineState.STOPPED)
    }

    fun markStopUnverified() {
      setMachineState(GatewayMachineState.DEGRADED)
    }

    fun start(ctx: Context) {
      startServiceWithStableReason(ctx, "START")
    }

    fun install(ctx: Context) {
      startServiceWithStableReason(ctx, "INSTALL")
    }

    fun stop(ctx: Context) {
      try {
        ctx.startService(Intent(ctx, MobileGatewayService::class.java).setAction("STOP"))
      } catch (e: Exception) {
        logRaw(ctx, "service stop blocked: ${e.message}")
        throw IllegalStateException(REASON_SERVICE_START_BLOCKED, e)
      }
    }

    /**
     * Ask the platform to run the service as a foreground service.
     *
     * Android 12+ refuses a foreground-service start from the background and
     * throws ForegroundServiceStartNotAllowedException, whose message begins
     * "startForegroundService() not allowed due…". That text is Android
     * internals, never user copy, so it is translated into the stable
     * [REASON_SERVICE_START_BLOCKED] token: screens render plain words and the
     * raw platform message stays out of the reporting path. Background starts
     * keep the app's existing expedited-worker route (BootReceiver/BootWorker).
     */
    private fun startServiceWithStableReason(ctx: Context, action: String) {
      val i = Intent(ctx, MobileGatewayService::class.java).setAction(action)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try {
          ctx.startForegroundService(i)
        } catch (e: Exception) {
          // Keep the raw platform text in the log (it is diagnostics, not
          // copy) and hand the UI the stable token instead.
          logRaw(ctx, "service start blocked: ${e.message}")
          throw IllegalStateException(REASON_SERVICE_START_BLOCKED, e)
        }
      } else {
        ctx.startService(i)
      }
    }

    /** Append one timestamped line to service.log; never throws. */
    fun logRaw(ctx: Context, line: String) {
      try {
        val f = File(Bootstrap.rootDir(ctx), "service.log")
        rotateLogFile(f, MAX_LOG_BYTES, KEEP_LOG_BYTES)
        val ts = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
          .format(java.util.Date())
        f.appendText("$ts $line\n")
      } catch (_: Exception) { }
    }

    /** File-level rotation shared by instance appendLog and static logRaw. */
    fun rotateLogFile(f: File, max: Long, keep: Long) {
      try {
        if (!f.exists() || f.length() <= max) return
        val raf = java.io.RandomAccessFile(f, "r")
        try {
          val start = (f.length() - keep).coerceAtLeast(0)
          raf.seek(start)
          val tail = ByteArray((f.length() - start).toInt())
          raf.readFully(tail)
          f.writeBytes(tail)
        } finally {
          try { raf.close() } catch (_: Exception) { }
        }
      } catch (_: Exception) { }
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
