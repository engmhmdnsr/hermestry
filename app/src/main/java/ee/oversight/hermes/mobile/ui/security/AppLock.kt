package ee.oversight.hermes.mobile.ui.security

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ee.oversight.hermes.mobile.ui.theme.CyberBg
import ee.oversight.hermes.mobile.ui.theme.NeonCyan
import ee.oversight.hermes.mobile.ui.theme.TextPrimary
import ee.oversight.hermes.mobile.ui.theme.TextSecondary
import ee.oversight.hermes.mobile.ui.chat.AutoApproveState

/**
 * Policy: while the app is locked, approval auto-resolve must be paused.
 * An unattended locked phone must never allow tool runs on its own, so the
 * MainActivity lock-gate call site suppresses the in-memory global
 * auto-approve flag for the whole locked window and restores it on unlock.
 * Suppression is memory-only (never persisted) so the user's saved setting
 * survives the lock cycle.
 */
object AppLockSession {
  @Volatile
  var locked: Boolean = false

  private var savedAutoApprove: Boolean? = null

  /** Pause in-memory global auto-approve while locked (never persisted). */
  fun suppressAutoApprove() {
    if (savedAutoApprove == null) savedAutoApprove = AutoApproveState.global
    AutoApproveState.global = false
  }

  /** Restore the pre-lock auto-approve value after unlock. */
  fun restoreAutoApprove() {
    savedAutoApprove?.let { AutoApproveState.global = it }
    savedAutoApprove = null
  }
}

/**
 * App-lock preference helper. Backed by the shared "hermes_mobile"
 * SharedPreferences (same file the MobileViewModel uses).
 */
object AppLockPrefs {
  private const val KEY_APP_LOCK = "pref_app_lock_enabled"

  fun isEnabled(context: Context): Boolean =
    context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .getBoolean(KEY_APP_LOCK, false)

  fun setEnabled(context: Context, enabled: Boolean) {
    context.getSharedPreferences("hermes_mobile", Context.MODE_PRIVATE)
      .edit().putBoolean(KEY_APP_LOCK, enabled).apply()
  }
}

/**
 * Full-screen app-lock gate, ported from Control's BiometricLockGate.
 *
 * Zero-dependency unlock: uses KeyguardManager device-credential confirmation
 * (system PIN / pattern / biometric — whatever the device enforces), which
 * works from a plain ComponentActivity with no androidx.biometric dep.
 */
@Composable
fun AppLockGate(onUnlocked: () -> Unit) {
  val context = LocalContext.current
  val km = remember(context) {
    context.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager
  }
  var noLockSet by remember { mutableStateOf(false) }
  val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
    androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
  ) { result ->
    if (result.resultCode == android.app.Activity.RESULT_OK) onUnlocked()
  }
  // Disable flow: the device credential must confirm FIRST; the lock is only
  // disarmed after RESULT_OK. No credential check = no disable.
  val disableLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
    androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
  ) { result ->
    if (result.resultCode == android.app.Activity.RESULT_OK) {
      AppLockPrefs.setEnabled(context, false)
      onUnlocked()
    }
  }
  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(CyberBg),
    contentAlignment = Alignment.Center
  ) {
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.Center,
      modifier = Modifier.padding(32.dp)
    ) {
      Text("\uD83D\uDD12", fontSize = 44.sp, fontFamily = FontFamily.Monospace)
      Spacer(Modifier.height(16.dp))
      Text(
        "Hermes Mobile",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        color = NeonCyan,
        fontFamily = FontFamily.Monospace
      )
      Spacer(Modifier.height(8.dp))
      Text(
        if (noLockSet) "No screen lock is set on this device. Set one first, or disable app lock below."
        else "Locked. Confirm your device PIN, pattern, or fingerprint to continue.",
        fontSize = 12.sp,
        color = TextSecondary,
        fontFamily = FontFamily.Monospace,
        textAlign = TextAlign.Center
      )
      Spacer(Modifier.height(20.dp))
      Button(
        onClick = {
          if (noLockSet) {
            context.startActivity(
              Intent(Settings.ACTION_SECURITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
          } else {
            val intent = km.createConfirmDeviceCredentialIntent(
              "Unlock Hermes Mobile", "Confirm device credential to continue")
            if (intent != null) launcher.launch(intent)
            else noLockSet = true
          }
        },
        modifier = Modifier.fillMaxWidth()
      ) {
        Text(if (noLockSet) "Open security settings" else "Unlock",
          fontSize = 13.sp, fontFamily = FontFamily.Monospace)
      }
      Spacer(Modifier.height(8.dp))
      TextButton(onClick = {
        val intent = km.createConfirmDeviceCredentialIntent(
          "Disable app lock", "Confirm device credential to disable app lock")
        if (intent != null) disableLauncher.launch(intent)
        else noLockSet = true
      }) {
        Text(
          "Disable app lock and continue",
          fontSize = 12.sp,
          color = TextPrimary,
          fontFamily = FontFamily.Monospace
        )
      }
    }
  }
}
