package ee.oversight.hermes.mobile;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "HermesMain";

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
    }

    // Single gate for every debug-only code path in this activity.
    // Release builds (debuggable=false) take the silent path above.
    private boolean isDebuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
