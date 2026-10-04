package ee.oversight.hermes.mobile

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.DocumentsContract
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import ee.oversight.hermes.mobile.install.Bootstrap
import ee.oversight.hermes.mobile.install.stableFailure
import ee.oversight.hermes.mobile.security.SecurePrefs
import ee.oversight.hermes.mobile.service.MobileGatewayService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * Capacitor bridge for the on-device Hermes gateway runner.
 *
 * Methods: install() streams progress events then resolves; start() launches
 * the foreground gateway service; stop() halts it; status() resolves
 * {running, state}; setAutostart({enabled}) persists the opt-in flag that
 * BootReceiver reads. Install progress uses Bootstrap's own step callback,
 * parsed for percent lines into installProgress events.
 */
@CapacitorPlugin(name = "HermesGateway")
class HermesGatewayPlugin : Plugin() {

  // SupervisorJob: install()/stop() run here too, and one escaping throw
  // (a null system service, a call settled twice) must not cancel this scope
  // for the process lifetime, which is exactly how every later call ends up
  // silently doing nothing.
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val pctRe = Regex("(\\d{1,3})%")
  // Voice I/O: the Capacitor WebView has no Web Speech APIs, so the chat
  // layer probes for these. speechRecognize delegates to the system
  // recognizer via RecognizerIntent (no RECORD_AUDIO needed: the recognizer
  // app owns the mic); ttsSpeak/ttsStop drive android TextToSpeech.
  private val REQ_SPEECH = 0x48E7
  private var pendingSpeechCall: PluginCall? = null
  private var pendingSpeechMax = 500
  // Project folders: SAF tree picker (persisted URI permission). Only the
  // (SAF tree IDs are opaque; primary volume also resolves to a host path
  // for display, everything else imports straight from the URI).
  private val REQ_PROJECT_DIR = 0x49A1
  private var pendingProjectCall: PluginCall? = null
  private val REQ_EXPORT_DIR = 0x49A2
  private var pendingExportId: String? = null
  private var pendingExportCall: PluginCall? = null
  // Project ids come from the app (slug + base36 stamp): keep them
  // filesystem-safe before they reach .projects/<id>.
  private val ID_RE = Regex("[A-Za-z0-9_-]{1,64}")
  private val IMPORT_BYTE_CAP = 100L * 1024 * 1024
  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private var ttsDead = false
  // installInFlight lives in the companion (process-wide): see its comment.

  // --- Voice I/O: mic dictation + read-aloud (chat layer probes) ---

  override fun load() {
    super.load()
    // Warm up TTS so the first speaker tap finds a ready engine.
    try { getTts() } catch (_: Exception) { }
  }

  @PluginMethod
  fun speechRecognize(call: PluginCall) {
    if (pendingSpeechCall != null) { call.reject("busy"); return }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) { call.reject("unavailable"); return }
    val locale = (call.getString("locale") ?: "en").replace('_', '-')
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    }
    if (intent.resolveActivity(context.packageManager) == null) { call.reject("unavailable"); return }
    pendingSpeechMax = call.getInt("maxChars") ?: 500
    pendingSpeechCall = call
    startActivityForResult(call, intent, REQ_SPEECH)
  }

  // Projects: the user's folder is IMPORTED into app-private storage
  // (files/debian/hermes_home/.projects/<id>) via the SAF tree the user
  // picked. No MANAGE_EXTERNAL_STORAGE: raw /storage paths are unreadable
  // on Android 11+, and Play rejects that permission for non-file-manager
  // apps. The gateway works on the imported copy; exportProjectTree copies
  // it back out. Bonus: any volume the picker offers (SD card, USB,
  // Downloads provider) is importable, not just primary storage.
  @PluginMethod
  fun importProjectTree(call: PluginCall) {
    val uriStr = call.getString("uri") ?: ""
    val id = call.getString("id") ?: ""
    if (!ID_RE.matches(id)) { call.reject("bad_id"); return }
    val uri = try { Uri.parse(uriStr) } catch (_: Exception) { call.reject("bad_uri"); return }
    if (uri == null) { call.reject("bad_uri"); return }
    scope.launch {
      try {
        val dest = java.io.File(Bootstrap.hermesHome(context), ".projects/$id")
        if (dest.exists()) { call.reject("exists"); return@launch }
        val root = androidx.documentfile.provider.DocumentFile.fromTreeUri(context, uri)
          ?: run { call.reject("bad_uri"); return@launch }
        var count = 0
        var bytes = 0L
        copyDocTree(root, dest) { n, b ->
          count += n; bytes += b
          if (bytes > IMPORT_BYTE_CAP) throw ImportTooLarge()
        }
        val ret = JSObject()
        ret.put("count", count)
        ret.put("guestPath", "/root/.projects/$id")
        call.resolve(ret)
      } catch (e: ImportTooLarge) {
        try { java.io.File(Bootstrap.hermesHome(context), ".projects/$id").deleteRecursively() } catch (_: Exception) { }
        call.reject("too_large")
      } catch (_: Exception) {
        try { java.io.File(Bootstrap.hermesHome(context), ".projects/$id").deleteRecursively() } catch (_: Exception) { }
        call.reject("copy_failed")
      }
    }
  }

  @PluginMethod
  fun exportProjectTree(call: PluginCall) {
    val id = call.getString("id") ?: ""
    if (!ID_RE.matches(id)) { call.reject("bad_id"); return }
    val src = java.io.File(Bootstrap.hermesHome(context), ".projects/$id")
    if (!src.isDirectory) { call.reject("not_found"); return }
    if (pendingExportCall != null) { call.reject("busy"); return }
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    if (intent.resolveActivity(context.packageManager) == null) { call.reject("unavailable"); return }
    pendingExportId = id
    pendingExportCall = call
    startActivityForResult(call, intent, REQ_EXPORT_DIR)
  }

  private class ImportTooLarge : Exception()

  private fun copyDocTree(src: androidx.documentfile.provider.DocumentFile, dest: java.io.File, onBytes: (files: Int, bytes: Long) -> Unit) {
    if (src.isDirectory) {
      dest.mkdirs()
      for (child in src.listFiles()) {
        val name = child.name ?: continue
        copyDocTree(child, java.io.File(dest, name), onBytes)
      }
      return
    }
    val len = src.length()
    dest.parentFile?.mkdirs()
    context.contentResolver.openInputStream(src.uri)?.use { ins ->
      dest.outputStream().use { outs -> ins.copyTo(outs) }
    } ?: throw java.io.IOException("unreadable ${src.uri}")
    onBytes(1, if (len > 0) len else dest.length())
  }

  private fun copyFileTreeToDoc(src: java.io.File, destDir: androidx.documentfile.provider.DocumentFile): Int {
    var count = 0
    for (child in src.listFiles() ?: return 0) {
      if (child.isDirectory) {
        val sub = destDir.createDirectory(child.name) ?: continue
        count += copyFileTreeToDoc(child, sub)
      } else {
        val mime = android.webkit.MimeTypeMap.getSingleton()
          .getMimeTypeFromExtension(child.extension.lowercase()) ?: "application/octet-stream"
        val doc = destDir.createFile(mime, child.name) ?: continue
        context.contentResolver.openOutputStream(doc.uri)?.use { outs ->
          child.inputStream().use { ins -> ins.copyTo(outs) }
        } ?: continue
        count++
      }
    }
    return count
  }

  @PluginMethod
  fun pickProjectDir(call: PluginCall) {
    if (pendingProjectCall != null) { call.reject("busy"); return }
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    if (intent.resolveActivity(context.packageManager) == null) { call.reject("unavailable"); return }
    pendingProjectCall = call
    startActivityForResult(call, intent, REQ_PROJECT_DIR)
  }

  override fun handleOnActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.handleOnActivityResult(requestCode, resultCode, data)
    if (requestCode == REQ_EXPORT_DIR) {
      val call = pendingExportCall
      val id = pendingExportId
      pendingExportCall = null
      pendingExportId = null
      if (call == null || id == null) return
      if (resultCode != Activity.RESULT_OK || data?.data == null) { call.reject("cancelled"); return }
      val uri = data.data!!
      scope.launch {
        try {
          try {
            context.contentResolver.takePersistableUriPermission(
              uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
          } catch (_: Exception) { }
          val destRoot = androidx.documentfile.provider.DocumentFile.fromTreeUri(context, uri)
            ?: run { call.reject("bad_uri"); return@launch }
          val src = java.io.File(Bootstrap.hermesHome(context), ".projects/$id")
          if (!src.isDirectory) { call.reject("not_found"); return@launch }
          val count = copyFileTreeToDoc(src, destRoot)
          val ret = JSObject()
          ret.put("count", count)
          call.resolve(ret)
        } catch (_: Exception) { call.reject("copy_failed") }
      }
      return
    }
    if (requestCode == REQ_PROJECT_DIR) {
      val call = pendingProjectCall
      pendingProjectCall = null
      if (call == null) return
      if (resultCode != Activity.RESULT_OK || data?.data == null) { call.reject("cancelled"); return }
      val uri = data.data!!
      try {
        context.contentResolver.takePersistableUriPermission(
          uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
      } catch (_: Exception) { call.reject("permission"); return }
      val treeId = try { DocumentsContract.getTreeDocumentId(uri) } catch (_: Exception) { null }
      // Primary volume resolves to a host path (legacy symlink binds use
      // it); anything else imports from the URI with hostPath left empty.
      val hostPath = if (treeId != null && treeId.startsWith("primary:")) {
        "/storage/emulated/0/" + treeId.removePrefix("primary:")
      } else ""
      val ret = JSObject()
      ret.put("uri", uri.toString())
      ret.put("name", hostPath.trimEnd('/').substringAfterLast('/').ifEmpty {
        (if (treeId != null && treeId.contains(":")) treeId.substringAfter(":").substringAfterLast("/").ifEmpty { null } else null) ?: "project"
      })
      ret.put("hostPath", hostPath.trimEnd('/'))
      call.resolve(ret)
      return
    }
    if (requestCode != REQ_SPEECH) return
    val call = pendingSpeechCall
    pendingSpeechCall = null
    if (call == null) return
    if (resultCode == Activity.RESULT_OK && data != null) {
      val text = (data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: "").take(pendingSpeechMax)
      if (text.isBlank()) { call.reject("empty"); return }
      val ret = JSObject()
      ret.put("transcript", text)
      call.resolve(ret)
    } else {
      call.reject("cancelled")
    }
  }

  private fun getTts(): TextToSpeech? {
    if (ttsDead) return null
    val existing = tts
    if (existing != null) return if (ttsReady) existing else null
    tts = TextToSpeech(context) { status ->
      if (status == TextToSpeech.SUCCESS) { ttsReady = true }
      else { ttsDead = true; tts = null }
    }
    return null
  }

  @PluginMethod
  fun ttsSpeak(call: PluginCall) {
    val text = call.getString("text") ?: ""
    if (text.isBlank()) { call.reject("empty"); return }
    val engine = getTts()
    if (engine == null) { call.reject(if (ttsDead) "unavailable" else "not_ready"); return }
    try {
      val tag = (call.getString("locale") ?: "en").replace('_', '-')
      val avail = engine.setLanguage(Locale.forLanguageTag(tag))
      if (avail == TextToSpeech.LANG_MISSING_DATA || avail == TextToSpeech.LANG_NOT_SUPPORTED) {
        engine.setLanguage(Locale.ENGLISH)
      }
      engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "hermes-${System.currentTimeMillis()}")
      call.resolve()
    } catch (_: Exception) { call.reject("failed") }
  }

  @PluginMethod
  fun ttsStop(call: PluginCall) {
    try { tts?.stop() } catch (_: Exception) { }
    call.resolve()
  }

  @PluginMethod
  fun monotonicNow(call: PluginCall) {
    // Wall-clock-immune timestamp for the PIN lockout deadline: the user
    // can move the device clock, but not elapsedRealtime (it resets only
    // on reboot, where the persisted wall-clock deadline takes over).
    call.resolve(JSObject().put("now", SystemClock.elapsedRealtime()))
  }

  @PluginMethod
  fun install(call: PluginCall) {
    if (!installInFlight.compareAndSet(false, true)) {
      call.reject("install_in_progress")
      return
    }
    call.setKeepAlive(true)
    scope.launch {
      // Screen-off survival: a partial wake lock keeps the CPU running and
      // a high-perf wifi lock keeps the radio awake, so Doze cannot stall
      // the ~305MB image download when the display sleeps. Released below.
      // Guarded: getSystemService(WIFI_SERVICE) is null on devices without
      // Wi-Fi, and an unguarded cast here escaped the coroutine before any
      // try/finally existed.
      val wakeLock = try {
        (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
          ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hermes:install")
      } catch (_: Exception) { null }
      val wifiLock = try {
        (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
          ?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hermes:install")
      } catch (_: Exception) { null }
      try {
        // Bounded by the install tail loop (~10 min), not the service 45-min
        // window: a stalled download must not hold the CPU for half an hour.
        wakeLock?.acquire(10 * 60 * 1000L)
      } catch (_: Exception) { }
      try {
        // WifiLock has no timed acquire (unlike WakeLock): it is held until
        // the matching release below, so screen-off cannot drop the radio
        // mid-download.
        wifiLock?.acquire()
      } catch (_: Exception) { }
      try {
        // INSTALL-04: fail fast before the ~305MB download when storage is short.
        val pre = try { Bootstrap.storagePreflight(context) } catch (_: Exception) { null }
        if (pre != null && !pre.enough) {
          val freeLabel = if (pre.freeBytes < 0L) "unknown" else "${pre.freeMb}MB"
          val msg = "needs_space: $freeLabel free, ${pre.neededMb}MB required"
          notifyListeners("installDone", JSObject()
            .put("ok", false)
            .put("error", msg), true)
          call.reject(msg)
          return@launch
        }
        // Drop stale artifacts BEFORE asking the service to start. The
        // service deletes them asynchronously in runInstall(), so a leftover
        // "ok" from a previous run could be read first and resolve this
        // install as successful without installing anything. install.log too:
        // otherwise the tail below replays the previous run's lines first,
        // which pins lastPhase (phases only move forward) at DONE and hides
        // the new run's earlier phases.
        try { java.io.File(Bootstrap.rootDir(context), "install.done").delete() } catch (_: Exception) { }
        try { java.io.File(Bootstrap.rootDir(context), "install.log").delete() } catch (_: Exception) { }
        // The install itself runs inside the foreground service, which the
        // OS must keep alive with the screen off. Here we only tail its log.
        try {
          MobileGatewayService.install(context)
        } catch (e: Exception) {
          val msg = stableFailure(e, "install_start_failed")
          notifyListeners("installDone", JSObject()
            .put("ok", false)
            .put("error", msg), true)
          call.reject(msg)
          return@launch
        }
        val root = Bootstrap.rootDir(context)
        val log = java.io.File(root, "install.log")
        val done = java.io.File(root, "install.done")
        var offset = 0L
        // Highest phase already reported; installPhaseForLine only classifies
        // one line at a time, so without this an early informational line
        // could walk the phase bar backwards.
        var lastPhase = -1
        // Deadline: no install.log line and no verdict for this long means the
        // install is gone (the service was killed, or a Stop cancelled the
        // install job) or wedged. The loop is while(true) on a kept-alive
        // call, so without it the coroutine never returns: the call stays
        // alive for the life of the WebView, holding the wake/wifi locks and
        // polling forever with no error shown to the wizard.
        var lastActivityAt = System.currentTimeMillis()
        while (true) {
          try {
            if (log.exists()) {
              val lines = log.readLines()
              // The service recreates install.log for each run: a shorter
              // file means offset now points past the end and every line of
              // the new run would be silently skipped.
              if (lines.size.toLong() < offset) offset = 0
              while (offset < lines.size) {
                val line = lines[offset.toInt()]
                offset++
                lastActivityAt = System.currentTimeMillis()
                notifyListeners("installLog", JSObject().put("line", line), true)
                // INSTALL-03: real progress phases alongside the percent lines.
                try {
                  Bootstrap.installPhaseForLine(line)?.let { ph ->
                    // Phases are a linear pipeline: only move forward.
                    if (ph.ordinal > lastPhase) {
                      lastPhase = ph.ordinal
                      notifyListeners("installPhase", JSObject().put("phase", ph.name), true)
                    }
                  }
                } catch (_: Exception) { }
                pctRe.find(line)?.let { m ->
                  val pct = m.groupValues[1].toIntOrNull()?.coerceIn(0, 100) ?: return@let
                  notifyListeners("installProgress", JSObject()
                    .put("downloaded", pct)
                    .put("total", 100), true)
                }
              }
            }
            // install.done is published by rename (MobileGatewayService
            // writeDone), so a partial verdict cannot appear, but an empty or
            // unreadable read must still mean "not settled yet", never a
            // verdict: an error verdict would be rendered as-is.
            val verdict = if (done.exists()) {
              try { done.readText().trim() } catch (_: Exception) { "" }
            } else ""
            if (verdict.isNotEmpty()) {
              if (verdict == "ok") {
                notifyListeners("installDone", JSObject().put("ok", true), true)
                call.resolve(JSObject().put("ok", true))
              } else {
                val msg = verdict.removePrefix("error:").trim().ifEmpty { "install failed" }
                notifyListeners("installDone", JSObject()
                  .put("ok", false)
                  .put("error", msg), true)
                call.reject(msg)
              }
              return@launch
            }
          } catch (_: Exception) { }
          if (System.currentTimeMillis() - lastActivityAt > INSTALL_IDLE_TIMEOUT_MS) {
            // Stable token, never the platform text: plainFailure maps it to
            // one line of copy while install.log keeps the raw detail.
            val msg = "install_timeout"
            notifyListeners("installDone", JSObject()
              .put("ok", false)
              .put("error", msg), true)
            call.reject(msg)
            return@launch
          }
          kotlinx.coroutines.delay(700)
        }
      } finally {
        installInFlight.set(false)
        try {
          if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) { }
        try {
          if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) { }
      }
    }
  }

  @PluginMethod
  fun start(call: PluginCall) {
    // Keystore crypto + multi-file disk I/O must not run on the main thread.
    val t = Thread {
      try {
      if (!Bootstrap.isInstalled(context)) {
        call.reject("not_installed: run install() first")
        return@Thread
      }
      // Consult compat metadata at start and refuse an incompatible image:
      // a stale/mixed rootfs fails later with obscure proot errors.
      // aarch64-only: legacy arches never write .image_ok, so skip them.
      val compat = try { Bootstrap.compatInfo() } catch (_: Exception) { null }
      if (Bootstrap.arch() == "aarch64" && !Bootstrap.isImageCompatible(context)) {
        call.reject("incompatible_image: on-disk image does not match " +
          "${compat?.imageVersion ?: Bootstrap.IMAGE_VERSION}, reinstall")
        return@Thread
      }
      Bootstrap.renderConfig(context)
      MobileGatewayService.start(context)
      call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "start_failed"))
      }
    }
    t.isDaemon = true
    t.start()
  }

  /**
   * Verified stop (GATEWAY-05): the STOP intent only asks the service to halt;
   * this polls process exit + port closed + health false and resolves
   * verified=true only when all three hold. The web UI may show STOPPED only
   * on verified=true (see gatewayState.ts).
   */
  @PluginMethod
  fun stop(call: PluginCall) {
    try {
      MobileGatewayService.stop(context)
    } catch (e: Exception) {
      call.reject(stableFailure(e, "stop_failed"))
      return
    }
    scope.launch {
      var v = MobileGatewayService.verifyStopped()
      // The kill + socket close race needs a moment; poll up to ~10s.
      var waited = 0
      while (!v.verified && waited < 10_000) {
        kotlinx.coroutines.delay(500)
        waited += 500
        v = MobileGatewayService.verifyStopped()
      }
      if (v.verified) MobileGatewayService.markStoppedVerified()
      else MobileGatewayService.markStopUnverified()
      try {
        call.resolve(JSObject()
          .put("ok", true)
          .put("verified", v.verified)
          .put("processExited", v.processExited)
          .put("portClosed", v.portClosed)
          .put("healthFalse", v.healthFalse))
      } catch (_: Exception) { }
    }
  }

  @PluginMethod
  fun health(call: PluginCall) {
    val up = healthOk()
    call.resolve(JSObject()
      .put("running", up)
      .put("state", if (up) "running" else "down"))
  }

  /**
   * What to report when nothing else is wrong: the secure store is refusing
   * secret writes (SecurePrefs full fallback), so the wizard's save silently
   * does nothing. A real gateway failure outranks it; a healthy store
   * reports nothing. Surfaced through lastError because that is the one error
   * field the web side already copies from the status report.
   */
  private fun secureStoreReason(): String? =
    if (SecurePrefs.isFallback()) SecurePrefs.lastError() else null

  /**
   * Single-machine status (GATEWAY-03/04): state is one of UNINITIALIZED,
   * CHECKING, NOT_INSTALLED, INSTALLING, INSTALLED, STARTING, RUNNING,
   * STOPPING, STOPPED, DEGRADED, FAILED. Legacy web strings
   * (running/installed_stopped/not_installed/failed...) are mapped in
   * gatewayState.ts; prefer the machine value. running stays for back-compat.
   */
  @PluginMethod
  fun status(call: PluginCall) {
    val installed = try { Bootstrap.isInstalled(context) } catch (_: Exception) { false }
    val failed = MobileGatewayService.gatewayFailed.value
    val reason = MobileGatewayService.gatewayFailureReason.value
      ?: MobileGatewayService.startupLastError.value
      ?: secureStoreReason()
    val up = healthOk()
    val machine = MobileGatewayService.gatewayState.value
    val state = when {
      failed || machine == MobileGatewayService.GatewayMachineState.FAILED -> "FAILED"
      up -> "RUNNING"
      machine == MobileGatewayService.GatewayMachineState.INSTALLING -> "INSTALLING"
      machine == MobileGatewayService.GatewayMachineState.STARTING -> "STARTING"
      machine == MobileGatewayService.GatewayMachineState.CHECKING -> "CHECKING"
      machine == MobileGatewayService.GatewayMachineState.STOPPING -> "STOPPING"
      machine == MobileGatewayService.GatewayMachineState.STOPPED -> "STOPPED"
      machine == MobileGatewayService.GatewayMachineState.DEGRADED -> "DEGRADED"
      !installed -> "NOT_INSTALLED"
      MobileGatewayService.everStarted -> "STOPPED"
      else -> "INSTALLED"
    }
    val compat = try { Bootstrap.compatInfo() } catch (_: Exception) { null }
    call.resolve(JSObject()
      .put("running", up)
      .put("state", state)
      .put("phase", MobileGatewayService.startupPhase.value.name)
      .put("elapsedMs", MobileGatewayService.elapsedMs())
      .put("lastError", reason ?: "")
      // Secure-store health: with the Keystore unavailable every secret write
      // is refused (SecurePrefs FALLBACK_ERROR), so the screens can say so
      // instead of letting a save silently do nothing.
      .put("secureStoreFallback", SecurePrefs.isFallback())
      .put("secureStoreError", SecurePrefs.lastError() ?: "")
      .put("logPath", java.io.File(Bootstrap.rootDir(context), "gateway.log").absolutePath)
      .put("retryable", state == "FAILED" || state == "DEGRADED" || state == "STOPPED")
      .put("installed", installed)
      .put("appVersion", compat?.appVersion ?: "")
      .put("gatewayVersion", compat?.gatewayVersion ?: "")
      .put("protocolVersion", compat?.protocolVersion ?: 0)
      .put("imageVersion", compat?.imageVersion ?: ""))
  }

  /** Startup phase detail (GATEWAY-04) without a full status round-trip. */
  @PluginMethod
  fun startupInfo(call: PluginCall) {
    val reason = MobileGatewayService.gatewayFailureReason.value
      ?: MobileGatewayService.startupLastError.value
      ?: secureStoreReason()
    call.resolve(JSObject()
      .put("phase", MobileGatewayService.startupPhase.value.name)
      .put("elapsedMs", MobileGatewayService.elapsedMs())
      .put("lastError", reason ?: "")
      // Same two fields as status(): a light-weight poll must be enough to
      // notice that secret writes are being refused.
      .put("secureStoreFallback", SecurePrefs.isFallback())
      .put("secureStoreError", SecurePrefs.lastError() ?: "")
      .put("logPath", java.io.File(Bootstrap.rootDir(context), "gateway.log").absolutePath)
      .put("retryable", MobileGatewayService.gatewayState.value ==
        MobileGatewayService.GatewayMachineState.FAILED))
  }

  /**
   * Install preflight (INSTALL-01/04): storage headroom + app/gateway/
   * protocol compatibility metadata. The web UI calls this before install()
   * and refuses with the numbers when enough=false.
   */
  @PluginMethod
  fun preflight(call: PluginCall) {
    try {
      val pre = Bootstrap.storagePreflight(context)
      val compat = Bootstrap.compatInfo()
      call.resolve(JSObject()
        .put("freeBytes", pre.freeBytes)
        .put("neededBytes", pre.neededBytes)
        .put("enough", pre.enough)
        .put("appVersion", compat.appVersion)
        .put("gatewayVersion", compat.gatewayVersion)
        .put("protocolVersion", compat.protocolVersion)
        .put("imageVersion", compat.imageVersion)
        .put("compatible", compat.compatible)
        .put("compatError", compat.error ?: ""))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "preflight_failed"))
    }
  }

  @PluginMethod
  fun setAutostart(call: PluginCall) {
    val enabled = call.getBoolean("enabled", false) ?: false
    try {
      context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
        .edit().putBoolean("autostart", enabled).apply()
      call.resolve(JSObject().put("autostart", enabled))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "autostart_update_failed"))
    }
  }

  @PluginMethod
  fun serverKey(call: PluginCall) {
    // Hand the minted local-API key to the WebView so its /api/* calls
    // pass auth. If not provisioned yet, mint it on demand into SecurePrefs.
    try {
      var key = SecurePrefs.getString(context, SecurePrefs.KEY_SERVER, "")
      if (key.isBlank()) {
        val rnd = ByteArray(24)
        java.security.SecureRandom().nextBytes(rnd)
        val minted = rnd.joinToString("") { "%02x".format(it) }
        SecurePrefs.putString(context, SecurePrefs.KEY_SERVER, minted)
        key = SecurePrefs.getString(context, SecurePrefs.KEY_SERVER, "")
      }
      if (key.isBlank()) call.reject("server key not provisioned yet")
      else call.resolve(JSObject().put("serverKey", key))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "server_key_unavailable"))
    }
  }

  @PluginMethod
  fun setProvider(call: PluginCall) {
    // Mirror the web-side active provider into the prefs renderConfig reads.
    // The gateway picks them up on next (re)start, no reinstall needed.
    // Optional extras (absent = leave the stored value alone, never wiped by
    // older callers): tg_token/tgToken, discord_token/discordToken,
    // server_key/serverKey. Blank token clears its slot; blank server key is
    // rejected loudly. Old 4-arg calls behave exactly as before.
    try {
      // Field-name tolerance (P0-C): the JS wrapper sends camelCase
      // (provider, apiKey, baseUrl, model, serverKey, tgToken, discordToken),
      // but the web settings names (modelId, base_url, api_key) and the
      // snake_case aliases are accepted too. First match wins, so a payload
      // using the documented names behaves exactly as before.
      val provider = call.getString("provider").orEmpty()
      val apiKey = (call.getString("apiKey") ?: call.getString("api_key")).orEmpty()
      val baseUrl = (call.getString("baseUrl") ?: call.getString("base_url")).orEmpty()
      val model = (call.getString("model") ?: call.getString("modelId")
        ?: call.getString("model_id")).orEmpty()
      context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE).edit()
        .putString("provider_name", provider)
        .putString("provider_base_url", baseUrl)
        .putString("model_id", model)
        .apply()
      // Active profile id (prov_<slug>_<rand>), so a later per-profile
      // secretSet for THIS profile can converge KEY_PROVIDER. Absent on old
      // callers, and then only the slug fallback below applies.
      val activeProfileId = (call.getString("activeProfileId")
        ?: call.getString("active_profile_id")).orEmpty()
      if (activeProfileId.isNotBlank()) {
        context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE).edit()
          .putString("provider_profile_id", activeProfileId)
          .apply()
      }
      SecurePrefs.clearError()
      // Converge provider key: if apiKey is provided, set KEY_PROVIDER and dual-write
      // the profile slot. If blank, check if a key exists for activeProfileId in SecurePrefs.
      // Owner tracking: KEY_PROVIDER remembers which profile put it there
      // (provider_key_owner). A blank wire for a DIFFERENT profile must not
      // inherit the previous profile's key: that leaks A's key into B's
      // session. Same-owner blanks still restore the stored per-profile key.
      val prefs = context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      val keyOwner = prefs.getString("provider_key_owner", "").orEmpty()
      if (apiKey.isNotBlank()) {
        SecurePrefs.putString(context, SecurePrefs.KEY_PROVIDER, apiKey)
        if (activeProfileId.isNotBlank()) {
          SecurePrefs.putString(context, "provider.${activeProfileId}.apiKey", apiKey)
          prefs.edit().putString("provider_key_owner", activeProfileId).apply()
        } else {
          prefs.edit().putString("provider_key_owner", provider).apply()
        }
      } else if (activeProfileId.isNotBlank()) {
        // Blank apiKey on the wire means 'unknown', not 'deleted': restore
        // the stored per-profile key when there is one, otherwise LEAVE
        // KEY_PROVIDER alone. Removing here destroyed legacy flat-only keys
        // (no per-profile copy exists), leaving the gateway credentialless.
        // Explicit removal goes through secretSet, which clears this slot.
        val storedProfileKey = SecurePrefs.getString(context, "provider.${activeProfileId}.apiKey", "")
        if (storedProfileKey.isNotBlank()) {
          SecurePrefs.putString(context, SecurePrefs.KEY_PROVIDER, storedProfileKey)
          prefs.edit().putString("provider_key_owner", activeProfileId).apply()
        } else if (keyOwner.isNotBlank() && keyOwner != activeProfileId) {
          // Owner mismatch with nothing stored for the new profile: the slot
          // still holds the previous profile's key. Clear it and the owner
          // rather than leaking one profile's key into another's session.
          SecurePrefs.remove(context, SecurePrefs.KEY_PROVIDER)
          prefs.edit().putString("provider_key_owner", "").apply()
        }
      } else if (provider.isBlank()) {
        // Same rule: a blank provider with a blank key carries no signal.
        // Only an explicit secretSet removal clears the slot.
      }
      // Dual-write the per-provider slug slot for legacy callers.
      if (provider.isNotBlank() && apiKey.isNotBlank() &&
          Regex("^[A-Za-z0-9_-]{1,64}$").matches(provider)) {
        SecurePrefs.putString(context, "provider.${provider}.apiKey", apiKey)
      }
      (call.getString("tg_token") ?: call.getString("tgToken"))?.let { t ->
        if (t.isBlank()) SecurePrefs.remove(context, SecurePrefs.KEY_TG)
        else SecurePrefs.putString(context, SecurePrefs.KEY_TG, t)
      }
      (call.getString("discord_token") ?: call.getString("discordToken"))?.let { t ->
        if (t.isBlank()) SecurePrefs.remove(context, SecurePrefs.KEY_DISCORD)
        else SecurePrefs.putString(context, SecurePrefs.KEY_DISCORD, t)
      }
      (call.getString("server_key") ?: call.getString("serverKey"))?.let { k ->
        if (k.isBlank()) {
          call.reject("server_key blank, refusing empty write")
          return
        }
        SecurePrefs.putString(context, SecurePrefs.KEY_SERVER, k)
      }
      val err = SecurePrefs.lastError()
      if (err != null) call.reject(err)
      else call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "provider_update_failed"))
    }
  }

  /**
   * Writes the local-API server key into the encrypted store and acks.
   * Fails loudly: blank input is rejected (an empty key would leave the
   * local API unintentionally open) and a failed crypto write rejects with
   * the SecurePrefs error instead of silently keeping the old value.
   */
  @PluginMethod
  fun setServerKey(call: PluginCall) {
    try {
      val key = (call.getString("serverKey") ?: call.getString("server_key")).orEmpty()
      if (key.isBlank()) {
        call.reject("server_key blank, refusing empty write")
        return
      }
      SecurePrefs.clearError()
      SecurePrefs.putString(context, SecurePrefs.KEY_SERVER, key)
      val err = SecurePrefs.lastError()
      if (err != null) call.reject(err)
      else call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "server_key_update_failed"))
    }
  }

  /**
   * Generic secret slots backed by SecurePrefs (EncryptedSharedPreferences).
   * The WebView keeps only blanked settings; real secrets live here.
   * Allowlist: provider profile keys "provider.<id>.apiKey" and the globals
   * global.serverKey / global.tgToken / global.discordToken /
   * global.appLockPin, plus the "lockout.<name>" counters the app-lock gate
   * owns. Anything else is rejected. Blank set removes the slot.
   */
  private val secretKeyRe = Regex("^(provider\\.[A-Za-z0-9_-]{1,64}\\.apiKey|global\\.(serverKey|tgToken|discordToken|appLockPin)|lockout\\.[A-Za-z0-9_-]{1,64})$")

  /**
   * Slot aliasing (AUTH-01): secretGet/secretSet address slots verbatim, but
   * the gateway service reads the short SecurePrefs keys (KEY_SERVER etc.).
   * Without this map the WebView and the gateway use DIFFERENT slots for the
   * same secret: the app sends 'global.serverKey' while the gateway enforces
   * 'server_key', so every request 401s forever and no restart can fix it.
   * appLockPin/lockout/provider slots are web-only and stay verbatim, except
   * that a provider write matching the active provider also refreshes
   * KEY_PROVIDER so the gateway picks it up on next (re)start.
   */
  private fun resolveSlot(key: String): String = when (key) {
    "global.serverKey" -> SecurePrefs.KEY_SERVER
    "global.tgToken" -> SecurePrefs.KEY_TG
    "global.discordToken" -> SecurePrefs.KEY_DISCORD
    else -> key
  }

  private fun activeProviderId(): String {
    return try {
      context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
        .getString("provider_name", "").orEmpty()
    } catch (_: Exception) { "" }
  }

  @PluginMethod
  fun secretGet(call: PluginCall) {
    try {
      val key = call.getString("key").orEmpty()
      if (!secretKeyRe.matches(key)) {
        call.reject("secret key not allowed")
        return
      }
      SecurePrefs.clearError()
      val value = SecurePrefs.getString(context, resolveSlot(key), "")
      val err = SecurePrefs.lastError()
      if (err != null) call.reject(err)
      else call.resolve(JSObject().put("value", value))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "secret_read_failed"))
    }
  }

  @PluginMethod
  fun secretSet(call: PluginCall) {
    try {
      val key = call.getString("key").orEmpty()
      if (!secretKeyRe.matches(key)) {
        call.reject("secret key not allowed")
        return
      }
      val value = call.getString("value").orEmpty()
      SecurePrefs.clearError()
      if (value.isBlank()) SecurePrefs.remove(context, resolveSlot(key))
      else SecurePrefs.putString(context, resolveSlot(key), value)
      // Converge the provider slots: the service reads only KEY_PROVIDER, so
      // a per-profile write for the ACTIVE profile refreshes it too. The
      // secret key carries the profile id (prov_<slug>_<rand>), which never
      // equals the provider slug, so compare against the stored active
      // profile id first and keep the slug as a legacy fallback.
      val m = Regex("^provider\\.([A-Za-z0-9_-]{1,64})\\.apiKey$").matchEntire(key)
      val seg = m?.groupValues?.getOrNull(1).orEmpty()
      val activeProfile = try {
        context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
          .getString("provider_profile_id", "").orEmpty()
      } catch (_: Exception) { "" }
      if (seg.isNotBlank() && (seg == activeProfile || seg == activeProviderId())) {
        if (value.isNotBlank()) {
          SecurePrefs.putString(context, SecurePrefs.KEY_PROVIDER, value)
          // Owner tracking: KEY_PROVIDER must remember which profile put it
          // here, otherwise a later blank setProvider cannot tell this key
          // from a stale one and the gateway boots credentialless.
          try {
            context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE).edit()
              .putString("provider_key_owner", seg).apply()
          } catch (_: Exception) { }
        } else {
          SecurePrefs.remove(context, SecurePrefs.KEY_PROVIDER)
          // Explicit removal drops ownership too, so a later blank for
          // another profile cannot be mistaken for this one's key.
          try {
            context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE).edit()
              .putString("provider_key_owner", "").apply()
          } catch (_: Exception) { }
        }
      }
      val err = SecurePrefs.lastError()
      if (err != null) call.reject(err)
      else call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "secret_write_failed"))
    }
  }

  /**
   * Alert channel (R1): approvals and job results while the app is closed.
   * Separate HIGH channel from the LOW gateway FGS channel so alerts are
   * never buried. notifState/requestNotifAlerts drive the Settings row;
   * notifyAlert posts. All fail soft (log + reject), alerts are best-effort,
   * the in-app queue stays authoritative.
   */
  @PluginMethod
  fun notifState(call: PluginCall) {
    try {
      val granted = if (Build.VERSION.SDK_INT >= 33) {
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED
      } else {
        true
      }
      call.resolve(JSObject().put("granted", granted))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "notif_state_failed"))
    }
  }

  @PluginMethod
  fun requestNotifAlerts(call: PluginCall) {
    try {
      val act = activity
      if (act == null) {
        call.reject("no activity to host the permission dialog")
        return
      }
      if (Build.VERSION.SDK_INT >= 33) {
        ActivityCompat.requestPermissions(
          act,
          arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
          9002
        )
      }
      call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "notif_request_failed"))
    }
  }

  @PluginMethod
  fun notifyAlert(call: PluginCall) {
    try {
      val title = call.getString("title").orEmpty().take(120)
      val body = call.getString("body").orEmpty().take(240)
      if (title.isBlank() && body.isBlank()) {
        call.reject("empty notification")
        return
      }
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try {
          nm.createNotificationChannel(
            NotificationChannel("alerts", "Hermes alerts", NotificationManager.IMPORTANCE_HIGH)
          )
        } catch (_: Exception) { }
      }
      val launch = PendingIntent.getActivity(
        context, 1,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE
      )
      val n = NotificationCompat.Builder(context, "alerts")
        .setContentTitle(title.ifBlank { "Hermes" })
        .setContentText(body)
        .setSmallIcon(android.R.drawable.stat_sys_warning)
        .setAutoCancel(true)
        .setContentIntent(launch)
        .build()
      nm.notify(alertSeq.incrementAndGet(), n)
      call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(stableFailure(e, "notify_failed"))
    }
  }

  private fun healthOk(): Boolean {
    return try {
      val c = URL("http://127.0.0.1:8080/health").openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
      c.setRequestProperty("Connection", "close")
      c.connectTimeout = 2_000
      c.readTimeout = 2_000
      val ok = c.responseCode in 200..299
      c.disconnect()
      ok
    } catch (_: Exception) {
      false
    }
  }

  /**
   * The bridge dies while the process lives on (WebView reload, activity
   * recreation, a fresh plugin instance), and this scope used to outlive it
   * uncancelled: every tail loop and stop poll kept running against a dead
   * call, holding wake/wifi locks forever. Cancelling runs each coroutine's
   * finally, which releases those locks; clearing the guard afterwards covers
   * a call that was cancelled before its body ever started (its finally
   * never runs, so installInFlight would otherwise stay true and reject every
   * future install() with install_in_progress).
   */
  override fun handleOnDestroy() {
    try { scope.cancel() } catch (_: Exception) { }
    try { installInFlight.set(false) } catch (_: Exception) { }
    try { tts?.shutdown() } catch (_:Exception) { }
    tts = null
    super.handleOnDestroy()
  }

  // --- Native HTTP stream bridge (chat SSE without WebView CORS) ---
  //
  // The WebView (https://localhost) cannot fetch() the gateway
  // (http://127.0.0.1:8080): no CORS headers come back. JSON calls go
  // through CapacitorHttp, but chat is a long-lived POST stream, which
  // CapacitorHttp cannot do. So the stream runs here on HttpURLConnection
  // and ships raw bytes as base64 chunks (base64 keeps multibyte UTF-8
  // split across reads intact: decoding stays on the JS TextDecoder).
  private val activeStreamConns = java.util.concurrent.ConcurrentHashMap<String, HttpURLConnection>()
  private val abortedStreamIds = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

  @PluginMethod
  fun streamPost(call: PluginCall) {
    val id = call.getString("id") ?: return call.reject("missing id")
    val urlStr = call.getString("url") ?: return call.reject("missing url")
    call.setKeepAlive(true)
    scope.launch {
      var conn: HttpURLConnection? = null
      try {
        conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 15000
          readTimeout = 0
          doOutput = true
          setRequestProperty("Content-Type", "application/json")
          call.getObject("headers")?.keys()?.forEach { k ->
            setRequestProperty(k, call.getObject("headers")!!.getString(k) ?: "")
          }
        }
        activeStreamConns[id] = conn
        conn.outputStream.use { it.write((call.getString("body") ?: "").toByteArray(Charsets.UTF_8)) }
        val status = conn.responseCode
        if (status !in 200..299) {
          notifyListeners("gwStreamStatus", JSObject().put("id", id).put("status", status))
          return@launch
        }
        val buf = ByteArray(8192)
        conn.inputStream.use { inp ->
          while (true) {
            val n = inp.read(buf)
            if (n < 0) break
            val b64 = android.util.Base64.encodeToString(buf.copyOf(n), android.util.Base64.NO_WRAP)
            notifyListeners("gwStreamChunk", JSObject().put("id", id).put("chunk", b64))
          }
        }
        notifyListeners("gwStreamDone", JSObject().put("id", id))
      } catch (e: Exception) {
        // streamAbort() disconnects the connection, which surfaces here as
        // an IOException on read: report it as cancelled, not as a failure.
        val cancelled = abortedStreamIds.remove(id) != null
        notifyListeners(
          "gwStreamError",
          JSObject().put("id", id).put("cancelled", cancelled)
            .put("message", if (cancelled) "aborted" else (e.message ?: "stream failed"))
        )
      } finally {
        activeStreamConns.remove(id)
        try { conn?.disconnect() } catch (_: Exception) {}
        call.resolve()
      }
    }
  }

  @PluginMethod
  fun streamAbort(call: PluginCall) {
    val id = call.getString("id")
    if (id != null) {
      abortedStreamIds[id] = true
      try { activeStreamConns.remove(id)?.disconnect() } catch (_: Exception) {}
    }
    call.resolve()
  }

  private companion object {
    // Atomic notifier id: wall-clock millis truncated to Int can collide and
    // overwrite a previous alert still sitting in the tray.
    val alertSeq = java.util.concurrent.atomic.AtomicInteger(1000)
    /** No install.log line and no install.done verdict for this long. */
    const val INSTALL_IDLE_TIMEOUT_MS = 10 * 60 * 1000L

    /**
     * One tail at a time: a second install() would delete the running
     * install's install.done (the verdict would be lost and both loops spin
     * forever) and take a second pair of wake/wifi locks.
     *
     * Process-wide on purpose: Bootstrap.install runs inside the service, not
     * here, so the guard has to survive a bridge recreation. Held per instance
     * it was a fresh false every time, and a new plugin instance could start a
     * second tail against the install the old instance had started.
     */
    val installInFlight = java.util.concurrent.atomic.AtomicBoolean(false)
  }
}
