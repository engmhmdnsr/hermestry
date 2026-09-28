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
        Bootstrap.install(context, onStep = { line ->
          val log = JSObject().put("line", line)
          notifyListeners("installLog", log, true)
          pctRe.find(line)?.let { m ->
            val pct = m.groupValues[1].toIntOrNull()?.coerceIn(0, 100) ?: return@let
            notifyListeners("installProgress", JSObject()
              .put("downloaded", pct)
              .put("total", 100), true)
          }
        })
        notifyListeners("installDone", JSObject().put("ok", true), true)
        call.resolve(JSObject().put("ok", true))
      } catch (e: Exception) {
        val msg = e.message ?: "install failed"
        notifyListeners("installDone", JSObject()
          .put("ok", false)
          .put("error", msg), true)
        call.reject(msg)
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

  @PluginMethod
  fun stop(call: PluginCall) {
    try {
      MobileGatewayService.stop(context)
      call.resolve(JSObject().put("ok", true))
    } catch (e: Exception) {
      call.reject(e.message ?: "stop failed")
    }
  }

  @PluginMethod
  fun status(call: PluginCall) {
    val installed = try { Bootstrap.isInstalled(context) } catch (_: Exception) { false }
    val failed = MobileGatewayService.gatewayFailed.value
    val reason = MobileGatewayService.gatewayFailureReason.value
    val up = healthOk()
    val state = when {
      failed -> "failed" + (if (!reason.isNullOrBlank()) ": $reason" else "")
      up -> "running"
      installed -> "installed_stopped"
      else -> "not_installed"
    }
    call.resolve(JSObject()
      .put("running", up)
      .put("state", state))
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
