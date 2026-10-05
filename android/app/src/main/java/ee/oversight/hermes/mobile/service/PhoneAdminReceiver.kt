package ee.oversight.hermes.mobile.service

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent

/** Device-admin holder for the agent's screen-lock request. Declared but
 * inert until the user activates it in Settings (Phone section): no
 * policies are enforced, the only privileged call is lockNow(). */
class PhoneAdminReceiver : DeviceAdminReceiver() {
  override fun onEnabled(context: Context, intent: Intent) {}
  override fun onDisabled(context: Context, intent: Intent) {}
}
