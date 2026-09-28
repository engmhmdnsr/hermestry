package ee.oversight.hermes.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HermesGatewayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
