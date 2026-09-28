package ee.oversight.hermes.mobile;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HermesGatewayPlugin.class);
        super.onCreate(savedInstanceState);
        // The app is served from https://localhost but the on-device gateway
        // binds plain http on 127.0.0.1:8080. Without this the WebView treats
        // every gateway fetch as mixed content and silently blocks it, so the
        // UI reports Offline while the gateway is actually listening.
        // Cleartext stays loopback-scoped via network_security_config.
        try {
            WebSettings settings = this.getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        } catch (Exception ignored) { }
    }
}
