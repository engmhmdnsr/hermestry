package ee.oversight.hermes.mobile;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "HermesMain";
    private static final int REQ_POST_NOTIFICATIONS = 9001;
    private static final String PREFS = "hermes_mobile";
    private static final String KEY_NOTIF_ASKED = "notif_permission_asked";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HermesGatewayPlugin.class);
        // Native "App" plugin (backButton event + exitApp) consumed by
        // src/App.tsx. Must be registered before super.onCreate so the plugin
        // exists when the web layer registers its backButton listener.
        registerPlugin(AppPlugin.class);
        super.onCreate(savedInstanceState);
        // The app is served from https://localhost but the on-device gateway
        // binds plain http on 127.0.0.1:8080. Without this the WebView treats
        // every gateway fetch as mixed content and silently blocks it, so the
        // UI reports Offline while the gateway is actually listening.
        // Cleartext stays loopback-scoped via network_security_config.
        try {
            WebSettings settings = this.getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        } catch (Exception e) {
            // Release path stays silent on purpose: no debug metadata in
            // the production artifact (REL-01). Debug builds log instead.
            if (isDebuggable()) {
                Log.d(TAG, "mixed-content override failed", e);
            }
        }
        // WebView remote debugging only on debuggable builds. Release builds
        // keep it off (SEC-01 acceptance: off in release).
        try {
            WebView.setWebContentsDebuggingEnabled(isDebuggable());
        } catch (Exception e) {
            if (isDebuggable()) {
                Log.d(TAG, "setWebContentsDebuggingEnabled failed", e);
            }
        }
        // R1: approval/job alerts need POST_NOTIFICATIONS on Android 13+.
        // Asked once, on launch, with the system dialog carrying the context.
        // A denial is final until the user flips it in system settings (the
        // Settings tab shows that state with a deep link).
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                            != PackageManager.PERMISSION_GRANTED
                    && !getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_NOTIF_ASKED, false)) {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_NOTIF_ASKED, true).apply();
                ActivityCompat.requestPermissions(
                        this,
                        new String[]{ android.Manifest.permission.POST_NOTIFICATIONS },
                        REQ_POST_NOTIFICATIONS);
            }
        } catch (Exception e) {
            if (isDebuggable()) {
                Log.d(TAG, "notification permission request failed", e);
            }
        }
    }

    // Single gate for every debug-only code path in this activity.
    // Release builds (debuggable=false) take the silent path above.
    private boolean isDebuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
