package ee.oversight.hermes.mobile.service

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.core.app.NotificationCompat

/**
 * Boot path on Android 12+: a receiver calling startForegroundService()
 * from the background throws ForegroundServiceStartNotAllowedException.
 * An expedited WorkManager job runs in a foreground context where
 * starting the gateway service is allowed.
 */
class BootWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
  private fun notif() = NotificationCompat.Builder(applicationContext, "gateway")
    .setContentTitle("Hermes Mobile starting")
    .setContentText("restoring on-phone gateway after boot")
    .setSmallIcon(android.R.drawable.stat_sys_upload_done)
    .build()

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
    setForeground(getForegroundInfo())
    // The WorkManager request may have been enqueued before the user opted
    // out, so re-check explicit consent here instead of starting blindly.
    val p = applicationContext.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
    if (!p.getBoolean("autostart", false)) return Result.success()
    return try {
      MobileGatewayService.start(applicationContext)
      Result.success()
    } catch (_: Exception) {
      // Cap retries: a permanently broken start (missing rootfs, denied FGS)
      // must not spin forever in the background.
      if (runAttemptCount >= 3) Result.failure() else Result.retry()
    }
  }
}
