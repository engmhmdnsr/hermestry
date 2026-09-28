package ee.oversight.hermes.mobile;

import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Minimal native "App" plugin: hardware/gesture back button plus exitApp.
 *
 * Why this exists (BACK-01): the web layer (src/App.tsx) resolves the App
 * plugin with registerPlugin('App') from @capacitor/core and listens for the
 * 'backButton' event to close the top-most overlay first, go Home second, and
 * exit last. @capacitor/app is deliberately NOT a dependency of this project,
 * and Capacitor 8 core registers no native App plugin of its own
 * (Bridge registers only CapacitorCookies, WebView, CapacitorHttp and
 * SystemBars), so without this class the listener never fires and the
 * hardware back key finishes the activity immediately, no matter what the
 * WebView history holds.
 *
 * Behavior:
 *   - a JS 'backButton' listener is registered: emit
 *     { canGoBack } and let the web layer decide (it calls exitApp() when
 *     nothing is left to dismiss),
 *   - no listener (bridge not ready, JS listener rejected): fall back to the
 *     pre-Capacitor-3 default, walk WebView history back and only finish the
 *     activity when there is nowhere left to go.
 *
 * If @capacitor/app is ever added as a dependency, delete this file and let
 * PluginManager (assets/capacitor.plugins.json) register the official plugin;
 * two plugins named "App" would otherwise be registered.
 */
@CapacitorPlugin(name = "App")
public class AppPlugin extends Plugin {

    private static final String BACK_BUTTON_EVENT = "backButton";

    private OnBackPressedCallback backCallback;

    @Override
    public void load() {
        try {
            backCallback = new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    handleBack();
                }
            };
            getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), backCallback);
        } catch (Exception e) {
            // Never let a missing activity/dispatcher break app startup. With
            // no callback installed the platform default (finish the activity)
            // still applies.
            backCallback = null;
        }
    }

    private void handleBack() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;

        if (hasListeners(BACK_BUTTON_EVENT)) {
            JSObject data = new JSObject();
            data.put("canGoBack", webView != null && webView.canGoBack());
            notifyListeners(BACK_BUTTON_EVENT, data);
            return;
        }

        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }

        getActivity().finish();
    }

    /** Matches the shape the web layer expects from @capacitor/app. */
    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve();
        getActivity().finish();
    }

    @Override
    protected void handleOnDestroy() {
        if (backCallback != null) {
            backCallback.remove();
            backCallback = null;
        }
        super.handleOnDestroy();
    }
}
