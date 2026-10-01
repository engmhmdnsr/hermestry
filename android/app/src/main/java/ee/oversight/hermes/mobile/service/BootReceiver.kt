package ee.oversight.hermes.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import ee.oversight.hermes.mobile.install.stableFailure

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val a = intent.action
    if (a == Intent.ACTION_BOOT_COMPLETED || a == "android.intent.action.QUICKBOOT_POWERON" ||
      a == Intent.ACTION_MY_PACKAGE_REPLACED || a == Intent.ACTION_USER_UNLOCKED
    ) {
      try {
        val p = ctx.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
        // Explicit opt-in only: absent key or false means no boot start.
        if (!p.contains("autostart") || !p.getBoolean("autostart", false)) return
        if (MobileGatewayService.gatewayState.value == MobileGatewayService.GatewayMachineState.RUNNING) return
        try {
          // Expedited work: allowed to start the foreground gateway from background
          // on Android 12+ (direct startForegroundService() would throw there).
          val req = OneTimeWorkRequestBuilder<BootWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
          // Unique boot work: BOOT_COMPLETED + USER_UNLOCKED can both fire for
          // one boot. KEEP dedupes enqueued/running work only, not a repeat
          // after SUCCEEDED, so BootWorker exits early when already RUNNING.
          WorkManager.getInstance(ctx).enqueueUniqueWork(
            "hermes-boot-start",
            ExistingWorkPolicy.KEEP,
            req
          )
        } catch (t: Throwable) {
          // Last resort: direct start (works on Android <= 11, throws on 12+).
          // Either way the outcome is written to service.log: a boot path that
          // only ever "catch (_: Exception) { }" silently does nothing on
          // Android 14+ with nothing to diagnose.
          val token = stableFailure(t, "service_start_blocked")
          MobileGatewayService.logRaw(ctx, "boot work enqueue failed: $token")
          try {
            MobileGatewayService.start(ctx)
          } catch (t2: Throwable) {
            MobileGatewayService.logRaw(
              ctx, "boot direct start failed: ${stableFailure(t2, "service_start_blocked")}"
            )
          }
        }
      } catch (t: Throwable) {
        // onReceive runs on the main thread: never let it escape.
        MobileGatewayService.logRaw(ctx, "boot receiver failed: ${stableFailure(t, "boot_failed")}")
      }
    }
  }
}
