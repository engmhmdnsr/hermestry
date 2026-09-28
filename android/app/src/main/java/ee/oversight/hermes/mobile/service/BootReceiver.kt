package ee.oversight.hermes.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val a = intent.action
    if (a == Intent.ACTION_BOOT_COMPLETED || a == "android.intent.action.QUICKBOOT_POWERON" ||
      a == Intent.ACTION_MY_PACKAGE_REPLACED
    ) {
      val p = ctx.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      // Explicit opt-in only: absent key or false means no boot start.
      if (!p.contains("autostart") || !p.getBoolean("autostart", false)) return
      try {
        // Expedited work: allowed to start the foreground gateway from background
        // on Android 12+ (direct startForegroundService() would throw there).
        val req = OneTimeWorkRequestBuilder<BootWorker>()
          .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
          .build()
        WorkManager.getInstance(ctx).enqueue(req)
      } catch (_: Exception) {
        // Last resort: direct start (works on Android <= 11, throws on 12+).
        try { MobileGatewayService.start(ctx) } catch (_: Exception) { }
      }
    }
  }
}
