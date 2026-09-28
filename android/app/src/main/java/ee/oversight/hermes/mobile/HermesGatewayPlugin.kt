package ee.oversight.hermes.mobile

import android.content.Context
import android.net.wifi.WifiManager
import android.os.PowerManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import ee.oversight.hermes.mobile.install.Bootstrap
import ee.oversight.hermes.mobile.security.SecurePrefs
import ee.oversight.hermes.mobile.service.MobileGatewayService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL

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

  private val scope = CoroutineScope(Dispatchers.IO)
  private val pctRe = Regex("(\\d{1,3})%")

  @PluginMethod
  fun install(call: PluginCall) {
    call.setKeepAlive(true)
    scope.launch {
      // Screen-off survival: a partial wake lock keeps the CPU running and
      // a high-perf wifi lock keeps the radio awake, so Doze cannot stall
      // the ~305MB image download when the display sleeps. Released below.
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      val wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hermes:install")
      val wifi = context.applicationContext
        .getSystemService(Context.WIFI_SERVICE) as WifiManager
      val wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hermes:install")
      try {
        wakeLock.acquire(30 * 60 * 1000L)
      } catch (_: Exception) { }
      try {
        wifiLock.acquire()
      } catch (_: Exception) { }
      try {
        // INSTALL-04: fail fast before the ~305MB download when storage is short.
        val pre = try { Bootstrap.storagePreflight(context) } catch (_: Exception) { null }
        if (pre != null && !pre.enough) {
          val msg = "needs_space: ${pre.freeMb}MB free, ${pre.neededMb}MB required"
          notifyListeners("installDone", JSObject()
            .put("ok", false)
            .put("error", msg), true)
          call.reject(msg)
          return@launch
        }
        // The install itself runs inside the foreground service, which the
        // OS must keep alive with the screen off. Here we only tail its log.
        try {
          MobileGatewayService.install(context)
        } catch (e: Exception) {
          notifyListeners("installDone", JSObject()
            .put("ok", false)
            .put("error", e.message ?: "could not start installer"), true)
          call.reject(e.message ?: "could not start installer")
          return@launch
        }
        val root = Bootstrap.rootDir(context)
        val log = java.io.File(root, "install.log")
        val done = java.io.File(root, "install.done")
        var offset = 0L
        while (true) {
          try {
            if (log.exists()) {
              val lines = log.readLines()
              while (offset < lines.size) {
                val line = lines[offset.toInt()]
                offset++
                notifyListeners("installLog", JSObject().put("line", line), true)
                // INSTALL-03: real progress phases alongside the percent lines.
                try {
                  Bootstrap.installPhaseForLine(line)?.let { ph ->
                    notifyListeners("installPhase", JSObject().put("phase", ph.name), true)
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
            if (done.exists()) {
              val verdict = try { done.readText().trim() } catch (_: Exception) { "" }
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
          kotlinx.coroutines.delay(700)
        }
      } finally {
        try {
          if (wakeLock.isHeld) wakeLock.release()
        } catch (_: Exception) { }
        try {
          if (wifiLock.isHeld) wifiLock.release()
        } catch (_: Exception) { }
      }
    }
  }

  @PluginMethod
  fun start(call: PluginCall) {
    try {
      if (!Bootstrap.isInstalled(context)) {
        call.reject("not_installed: run install() first")
        return
      }
      Bootstrap.renderConfig(context)
      MobileGatewayService.start(context)
      call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(e.message ?: "start failed")
    }
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
      call.reject(e.message ?: "stop failed")
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
    call.resolve(JSObject()
      .put("phase", MobileGatewayService.startupPhase.value.name)
      .put("elapsedMs", MobileGatewayService.elapsedMs())
      .put("lastError", reason ?: "")
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
      call.reject(e.message ?: "preflight failed")
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
      call.reject(e.message ?: "setAutostart failed")
    }
  }

  @PluginMethod
  fun serverKey(call: PluginCall) {
    // Hand the minted local-API key to the WebView so its /api/* calls
    // pass auth. Fail closed: blank means Bootstrap has not run yet.
    try {
      val key = SecurePrefs.getString(context, SecurePrefs.KEY_SERVER, "")
      if (key.isBlank()) call.reject("server key not provisioned yet")
      else call.resolve(JSObject().put("serverKey", key))
    } catch (e: Exception) {
      call.reject(e.message ?: "serverKey failed")
    }
  }

  @PluginMethod
  fun setProvider(call: PluginCall) {
    // Mirror the web-side active provider into the prefs renderConfig reads.
    // The gateway picks them up on next (re)start, no reinstall needed.
    try {
      val provider = call.getString("provider").orEmpty()
      val apiKey = call.getString("apiKey").orEmpty()
      val baseUrl = call.getString("baseUrl").orEmpty()
      val model = call.getString("model").orEmpty()
      context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE).edit()
        .putString("provider_name", provider)
        .putString("provider_base_url", baseUrl)
        .putString("model_id", model)
        .apply()
      SecurePrefs.putString(context, SecurePrefs.KEY_PROVIDER, apiKey)
      call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(e.message ?: "setProvider failed")
    }
  }

  private fun healthOk(): Boolean {
    return try {
      val c = URL("http://127.0.0.1:8080/health").openConnection() as HttpURLConnection
      c.connectTimeout = 2_000
      c.readTimeout = 2_000
      c.responseCode in 200..299
    } catch (_: Exception) {
      false
    }
  }
}
