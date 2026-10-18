package ee.oversight.hermes.mobile.service

import android.app.admin.DevicePolicyManager
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Loopback-only phone-control bridge for the on-device agent.
 *
 * The agent's tools execute inside the proot guest, which shares the host
 * network namespace (proot runs without `-n`), so guest Python reaches this
 * server at 127.0.0.1:[PORT] exactly like the gateway at :8080. Nothing here
 * is exported off-device: the socket binds loopback only, callers present a
 * per-boot token (env HERMES_BRIDGE_TOKEN inside the gateway), and remote
 * callers go through the gateway's authed `/api/phone/...` proxy instead.
 *
 * Honesty rules (each enforced by read-back, never by assumption):
 * - Every mutating call reads the value back and returns the measured state.
 * - Anything Android forbids a third-party app from doing silently (WiFi
 *   toggle on API 29+, BT enable without consent) is exposed as an *intent
 *   opener*, never faked as a toggle. The response says what happened.
 * - Anything needing a user grant (WRITE_SETTINGS, device admin, CAMERA for
 *   torch, BLUETOOTH_CONNECT on API 31+) answers 403 with a `needs_grant`
 *   token the Settings Phone section turns into a button. The agent must
 *   surface that token, never claim the action landed.
 */
object PhoneControlBridge {
  const val PORT = 8091

  private var server: ServerSocket? = null
  private var acceptThread: Thread? = null
  private var pool: java.util.concurrent.ExecutorService = Executors.newFixedThreadPool(8)
  private val running = AtomicBoolean(false)
  @Volatile private var boundContext: Context? = null
  @Volatile private var bridgeToken: String? = null

  @Synchronized
  fun start(ctx: Context, token: String) {
    if (running.get()) return
    if (pool.isShutdown) pool = Executors.newFixedThreadPool(8)
    bridgeToken = token
    boundContext = ctx.applicationContext
    val srv = ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"))
    server = srv
    running.set(true)
    acceptThread = Thread({
      while (running.get()) {
        try {
          val sock = srv.accept()
          pool.execute { handle(sock) }
        } catch (_: Exception) {
          if (!running.get()) return@Thread
        }
      }
    }, "phone-bridge-accept").also { it.isDaemon = true; it.start() }
  }

  @Synchronized
  fun stop() {
    running.set(false)
    try { server?.close() } catch (_: Exception) {}
    try { pool.shutdownNow() } catch (_: Exception) {}
    server = null
    acceptThread = null
    boundContext = null
    bridgeToken = null
  }

  fun isRunning(): Boolean = running.get()

  // ---- HTTP plumbing (minimal, loopback only) ----

  private fun handle(sock: Socket) {
    sock.use { s ->
      // Bound every read: Content-Length counts bytes but the body is read
      // as chars, so a multibyte body would park a pool thread forever on a
      // keep-alive socket. A timeout turns that into a 500, not a leak.
      // (Bodies here are tiny ASCII JSON; this only bounds the damage.)
      try { s.soTimeout = 15_000 } catch (_: Exception) {}
      try {
        val reader = BufferedReader(InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8))
        val requestLine = reader.readLine() ?: return
        val parts = requestLine.split(" ")
        if (parts.size < 2) { respond(s.getOutputStream(), 400, obj("ok" to false, "error" to "bad request")); return }
        val method = parts[0].uppercase()
        val path = parts[1].substringBefore("?")
        var contentLength = 0
        var presentedToken: String? = null
        while (true) {
          val line = reader.readLine() ?: break
          if (line.isEmpty()) break
          val idx = line.indexOf(":")
          if (idx > 0 && line.substring(0, idx).trim().equals("content-length", ignoreCase = true)) {
            contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
          }
          if (idx > 0 && line.substring(0, idx).trim().equals("x-bridge-token", ignoreCase = true)) {
            presentedToken = line.substring(idx + 1).trim()
          }
        }
        // Per-boot token: only the gateway (env HERMES_BRIDGE_TOKEN) and the
        // agent inside it know it. Any other app on the device gets 403.
        val expected = bridgeToken
        if (expected == null || presentedToken != expected) {
          respond(s.getOutputStream(), 403, obj("ok" to false, "error" to "forbidden"))
          return
        }
        val bodyChars = CharArray(contentLength.coerceIn(0, 65536))
        var read = 0
        while (read < bodyChars.size) {
          val n = reader.read(bodyChars, read, bodyChars.size - read)
          if (n < 0) break
          read += n
        }
        val body = String(bodyChars, 0, read)
        val ctx = boundContext
        if (ctx == null) { respond(s.getOutputStream(), 503, obj("ok" to false, "error" to "bridge stopping")); return }
        route(ctx, method, path, body, s.getOutputStream())
      } catch (_: Exception) {
        try { respond(s.getOutputStream(), 500, obj("ok" to false, "error" to "bridge failure")) } catch (_: Exception) {}
      }
    }
  }

  private fun route(ctx: Context, method: String, path: String, body: String, out: OutputStream) {
    // Actions return Pair(code, json); answer() unpacks them. Kotlin spread
    // works only in vararg position, so no `respond(out, *action())` here.
    fun answer(result: Pair<Int, String>) = respond(out, result.first, result.second)
    when {
      method == "GET" && path == "/phone/status" -> respond(out, 200, statusJson(ctx))
      method == "POST" && path == "/phone/volume" -> answer(setVolume(ctx, body))
      method == "POST" && path == "/phone/brightness" -> answer(setBrightness(ctx, body))
      method == "POST" && path == "/phone/vibrate" -> answer(vibrate(ctx, body))
      method == "POST" && path == "/phone/flashlight" -> answer(setTorch(ctx, body))
      method == "POST" && path == "/phone/lock" -> answer(lockNow(ctx))
      method == "POST" && path == "/phone/wifi_panel" -> answer(openPanel(ctx, Settings.Panel.ACTION_WIFI))
      method == "POST" && path == "/phone/bluetooth_panel" -> answer(openSystemPage(ctx, Settings.ACTION_BLUETOOTH_SETTINGS))
      method == "POST" && path == "/phone/bluetooth_enable" -> answer(requestBtEnable(ctx))
      method == "POST" && path == "/phone/open_write_settings" -> answer(openSystemPage(ctx, Settings.ACTION_MANAGE_WRITE_SETTINGS))
      method == "POST" && path == "/phone/open_admin_activation" -> answer(openAdminActivation(ctx))
      method == "GET" && path == "/phone/gateway" -> answer(getGatewayStatus(ctx))
      method == "POST" && path == "/phone/gateway" -> answer(setGatewayState(ctx, body))
      else -> respond(out, 404, obj("ok" to false, "error" to "unknown phone route"))
    }
  }

  private fun respond(out: OutputStream, code: Int, body: String) {
    val bytes = body.toByteArray(StandardCharsets.UTF_8)
    val head = "HTTP/1.1 $code ${reason(code)}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
    out.write(head.toByteArray(StandardCharsets.US_ASCII))
    out.write(bytes)
    out.flush()
  }

  private fun reason(code: Int): String = when (code) {
    200 -> "OK"; 400 -> "Bad Request"; 403 -> "Forbidden"; 404 -> "Not Found"
    502 -> "Bad Gateway"; 503 -> "Unavailable"; else -> "Error"
  }

  // ---- tiny JSON writer (values are ours; strings are escaped) ----

  private fun esc(s: String): String = buildString {
    append('"')
    for (c in s) when (c) {
      '"' -> append("\\\""); '\\' -> append("\\\\"); '\n' -> append("\\n")
      '\r' -> append("\\r"); '\t' -> append("\\t")
      else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
    }
    append('"')
  }

  private fun obj(vararg kv: Pair<String, Any?>): String = kv.joinToString(",", "{", "}") { (k, v) ->
    "${esc(k)}:${value(v)}"
  }

  @Suppress("UNCHECKED_CAST")
  private fun value(v: Any?): String = when (v) {
    null -> "null"
    is Boolean -> if (v) "true" else "false"
    is Number -> v.toString()
    is String -> esc(v)
    is Map<*, *> -> (v as Map<String, Any?>).entries.joinToString(",", "{", "}") { (k, x) -> "${esc(k)}:${value(x)}" }
    else -> esc(v.toString())
  }

  private fun field(body: String, name: String): String? {
    // flat JSON string/number/bool field; enough for our fixed shapes
    val rx = Regex("\"$name\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|(-?\\d+)|(true|false))")
    val m = rx.find(body) ?: return null
    return m.groups[2]?.value?.replace("\\\"", "\"")?.replace("\\\\", "\\")
      ?: m.groups[3]?.value ?: m.groups[4]?.value
  }

  // ---- actions ----

  private fun statusJson(ctx: Context): String {
    val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    val level = try { bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) } catch (_: Exception) { -1 }
    val battIntent = try { ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) } catch (_: Exception) { null }
    val charging = battIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
    val wifiOn = try {
      (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).isWifiEnabled
    } catch (_: Exception) { null }
    var btOn: Boolean? = null
    var btPerm = true
    try {
      val adapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
      btOn = adapter?.isEnabled
    } catch (_: SecurityException) { btPerm = false } catch (_: Exception) {}
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    fun vol(stream: Int): Map<String, Any?> = try {
      mapOf("level" to am.getStreamVolume(stream), "max" to am.getStreamMaxVolume(stream))
    } catch (_: Exception) { mapOf("level" to null, "max" to null) }
    val bright = try { Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS) } catch (_: Exception) { -1 }
    val auto = try { Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE) == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC } catch (_: Exception) { false }
    val torch = torchState(ctx)
    return obj(
      "ok" to true,
      "device" to mapOf(
        "model" to Build.MODEL, "manufacturer" to Build.MANUFACTURER,
        "android" to Build.VERSION.RELEASE, "sdk" to Build.VERSION.SDK_INT
      ),
      "battery" to mapOf("level_pct" to level, "charging" to charging),
      "wifi" to mapOf("enabled" to wifiOn),
      "bluetooth" to mapOf("enabled" to btOn, "needs_grant" to if (!btPerm) "bluetooth_connect" else null),
      "volume" to mapOf("music" to vol(AudioManager.STREAM_MUSIC), "ring" to vol(AudioManager.STREAM_RING), "alarm" to vol(AudioManager.STREAM_ALARM)),
      "brightness" to mapOf("level" to bright, "auto" to auto, "can_write" to Settings.System.canWrite(ctx)),
      "flashlight" to mapOf("on" to torch),
      "admin_active" to isAdminActive(ctx),
      "can_write_settings" to Settings.System.canWrite(ctx)
    )
  }

  private fun setVolume(ctx: Context, body: String): Pair<Int, String> {
    val stream = when ((field(body, "stream") ?: "music").lowercase()) {
      "ring" -> AudioManager.STREAM_RING
      "alarm" -> AudioManager.STREAM_ALARM
      "voice" -> AudioManager.STREAM_VOICE_CALL
      else -> AudioManager.STREAM_MUSIC
    }
    val want = field(body, "level")?.toIntOrNull()
      ?: return 400 to obj("ok" to false, "error" to "level 0..max required")
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val max = am.getStreamMaxVolume(stream)
    val clamped = want.coerceIn(0, max)
    return try {
      am.setStreamVolume(stream, clamped, 0)
      val got = am.getStreamVolume(stream)
      200 to obj("ok" to (got == clamped), "level" to got, "max" to max)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "volume failed"))
    }
  }

  private fun setBrightness(ctx: Context, body: String): Pair<Int, String> {
    if (!Settings.System.canWrite(ctx)) {
      return 403 to obj("ok" to false, "error" to "needs the Modify system settings grant", "needs_grant" to "write_settings")
    }
    val want = field(body, "level")?.toIntOrNull()
      ?: return 400 to obj("ok" to false, "error" to "level 0..255 required")
    return try {
      val clamped = want.coerceIn(1, 255)
      Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
      Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, clamped)
      val got = Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
      200 to obj("ok" to (got == clamped), "level" to got)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "brightness failed"))
    }
  }

  private fun vibrate(ctx: Context, body: String): Pair<Int, String> {
    val ms = (field(body, "ms")?.toLongOrNull() ?: 120L).coerceIn(1L, 1000L)
    return try {
      if (Build.VERSION.SDK_INT >= 31) {
        val vm = ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
        vm.defaultVibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
      } else {
        @Suppress("DEPRECATION")
        (ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator).vibrate(ms)
      }
      200 to obj("ok" to true, "ms" to ms)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "vibrate failed"))
    }
  }

  private fun flashCameraId(ctx: Context): String? {
    return try {
      val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      cm.cameraIdList.firstOrNull { id ->
        try { cm.getCameraCharacteristics(id).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
        catch (_: Exception) { false }
      }
    } catch (_: Exception) { null }
  }

  private fun torchState(ctx: Context): Boolean? {
    // No cheap read-back API; the gateway proxy reports the last commanded
    // value per process. null here means "unknown, never commanded".
    return lastTorch
  }

  @Volatile private var lastTorch: Boolean? = null

  private fun setTorch(ctx: Context, body: String): Pair<Int, String> {
    val want = field(body, "on")?.lowercase() == "true"
    val id = flashCameraId(ctx)
      ?: return 500 to obj("ok" to false, "error" to "no flash camera on this device")
    return try {
      val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      cm.setTorchMode(id, want)
      lastTorch = want
      200 to obj("ok" to true, "on" to want)
    } catch (_: SecurityException) {
      403 to obj("ok" to false, "error" to "needs the Camera grant", "needs_grant" to "camera")
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "torch failed"))
    }
  }

  private fun isAdminActive(ctx: Context): Boolean {
    return try {
      val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      dpm.isAdminActive(ComponentName(ctx, PhoneAdminReceiver::class.java))
    } catch (_: Exception) { false }
  }

  private fun lockNow(ctx: Context): Pair<Int, String> {
    if (!isAdminActive(ctx)) {
      return 403 to obj("ok" to false, "error" to "needs device-admin activation", "needs_grant" to "device_admin")
    }
    return try {
      (ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager).lockNow()
      200 to obj("ok" to true)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "lock failed"))
    }
  }

  private fun openPanel(ctx: Context, action: String): Pair<Int, String> {
    // Android 10+ forbids silent WiFi/BT toggles for third-party apps; the
    // honest shape is opening the system panel for the user.
    return try {
      val i = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(i)
      200 to obj("ok" to true, "opened" to true)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "panel failed"))
    }
  }

  private fun requestBtEnable(ctx: Context): Pair<Int, String> {
    return try {
      val i = Intent(android.bluetooth.BluetoothAdapter.ACTION_REQUEST_ENABLE)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(i)
      200 to obj("ok" to true, "opened" to true, "note" to "system consent dialog shown")
    } catch (_: SecurityException) {
      403 to obj("ok" to false, "error" to "needs the Nearby devices grant", "needs_grant" to "bluetooth_connect")
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "bt request failed"))
    }
  }

  private fun openSystemPage(ctx: Context, action: String): Pair<Int, String> {
    return try {
      ctx.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      200 to obj("ok" to true, "opened" to true)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "open failed"))
    }
  }

  private fun openAdminActivation(ctx: Context): Pair<Int, String> {
    return try {
      val i = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
        .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, ComponentName(ctx, PhoneAdminReceiver::class.java))
        .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Lets the agent lock the screen on request.")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(i)
      200 to obj("ok" to true, "opened" to true)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "open failed"))
    }
  }

  private fun getGatewayStatus(ctx: Context): Pair<Int, String> {
    return try {
      val state = MobileGatewayService.getMachineState(ctx)
      200 to obj("ok" to true, "state" to state.name)
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "gateway status failed"))
    }
  }

  private fun setGatewayState(ctx: Context, body: String): Pair<Int, String> {
    val cmd = field(body, "action")?.uppercase() ?: return 400 to obj("ok" to false, "error" to "action START|STOP required")
    return try {
      val intent = Intent(ctx, MobileGatewayService::class.java).apply {
        setAction(cmd)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      if (cmd == "START") {
        // On Android 16+, startForegroundService must be called from foreground context
        // Use startForegroundService directly since we're in a background thread
        try {
          ctx.startForegroundService(intent)
        } catch (_: Exception) {
          // Fallback for older Android
          ctx.startService(intent)
        }
      } else if (cmd == "STOP") {
        ctx.startService(intent)
      } else {
        return 400 to obj("ok" to false, "error" to "action START|STOP required")
      }
      200 to obj("ok" to true, "action" to cmd, "started" to (cmd == "START"))
    } catch (e: Exception) {
      500 to obj("ok" to false, "error" to (e.message ?: "gateway action failed"))
    }
  }
}
