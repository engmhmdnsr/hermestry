package ee.oversight.hermes.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class MobileApp : Application() {
  val vm: MobileViewModel by lazy { MobileViewModel(this) }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(
        NotificationChannel("gateway", "Hermes gateway", NotificationManager.IMPORTANCE_LOW)
      )
      nm.createNotificationChannel(
        NotificationChannel("replies", "Agent replies", NotificationManager.IMPORTANCE_HIGH)
      )
    }
  }
}
