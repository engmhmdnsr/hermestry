package ee.oversight.hermes.mobile.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.core.app.NotificationCompat
import androidx.core.os.UserManagerCompat
import ee.oversight.hermes.mobile.install.stableFailure

/**
 * Boot path on Android 12+: a receiver calling startForegroundService()
 * from the background throws ForegroundServiceStartNotAllowedException.
 * An expedited WorkManager job runs in a foreground context where
 * starting the gateway service is allowed.
 */
class BootWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
  private fun notif() = run {
    // Own the notify channel here too: boot work can run before the service
    // ever created it. Idempotent, no permission needed for FGS notifications.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
          NotificationChannel("gateway", "Hermes gateway", NotificationManager.IMPORTANCE_LOW)
        )
      } catch (_: Exception) { }
    }
    NotificationCompat.Builder(applicationContext, "gateway")
      .setContentTitle("Hermes Mobile starting")
      .setContentText("restoring on-phone gateway after boot")
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .build()
  }

  // Expedited work needs this up-front; without it WorkManager throws
  // IllegalStateException before doWork() ever runs.
  override suspend fun getForegroundInfo(): ForegroundInfo =
    if (Build.VERSION.SDK_INT >= 29) {
      // specialUse needs API 34+; older releases fall back to dataSync.
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      ForegroundInfo(2, notif(), type)
    } else {
      @Suppress("DEPRECATION") ForegroundInfo(2, notif())
    }

  override suspend fun doWork(): Result {
    // An expedited request downgraded to plain work (RUN_AS_NON_EXPEDITED)
    // or any background restriction makes setForeground() throw on Android
    // 12+. Unguarded, that ended doWork() before the gateway was ever
    // started, so autostart silently did nothing with no trace left behind.
    try {
      setForeground(getForegroundInfo())
    } catch (t: Throwable) {
      MobileGatewayService.logRaw(
        applicationContext,
        "boot worker foreground refused: ${stableFailure(t, REASON)}"
      )
    }
    // Defer start if device credential storage is still locked (Direct Boot)
    if (!UserManagerCompat.isUserUnlocked(applicationContext)) {
      MobileGatewayService.logRaw(
        applicationContext,
        "boot worker deferred: user credential storage is still locked"
      )
      return Result.retry()
    }
    // The WorkManager request may have been enqueued before the user opted
    // out, so re-check explicit consent here instead of starting blindly.
    val p = applicationContext.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
    if (!p.getBoolean("autostart", false)) return Result.success()
    // BOOT_COMPLETED can follow USER_UNLOCKED after the first worker already
    // SUCCEEDED (KEEP dedupes enqueued/running work only): a second worker
    // must not tear down and restart a running gateway.
    if (MobileGatewayService.gatewayState.value == MobileGatewayService.GatewayMachineState.RUNNING) return Result.success()
    return try {
      MobileGatewayService.start(applicationContext)
      Result.success()
    } catch (t: Throwable) {
      // Log the stable token so a dead autostart is diagnosable, then cap
      // retries: a permanently broken start (missing rootfs, denied FGS)
      // must not spin forever in the background.
      val token = stableFailure(t, REASON)
      MobileGatewayService.logRaw(applicationContext, "boot autostart failed: $token")
      if (runAttemptCount >= 3) {
        // Also publish it: service.log was the only place that ever learned
        // autostart had given up, so the app reported a plain STOPPED state
        // on the first open after boot. status()/startupInfo() read
        // startupLastError, and noteStart() clears it on the next Start.
        MobileGatewayService.startupLastError.value = "$REASON_BOOT_FAILED: $token"
        Result.failure()
      } else Result.retry()
    }
  }

  private companion object {
    const val REASON = "service_start_blocked"
    /**
     * Stable marker for "autostart gave up after its retries". Prefixed in
     * front of the underlying token so the failure mapper still sees that
     * token ("boot_failed: service_start_blocked") and keeps its own copy.
     */
    const val REASON_BOOT_FAILED = "boot_failed"
  }
}
