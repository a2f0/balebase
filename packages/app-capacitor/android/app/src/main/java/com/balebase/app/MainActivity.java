package com.balebase.app;

import android.graphics.Color;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PasswordManagerPlugin.class);
        super.onCreate(savedInstanceState);
        // Capacitor's SystemBars plugin pads the window for the keyboard, and for
        // system bars and cutouts unless the page draws under them; padding here
        // as well doubles the gaps. The page sets the bars' style (systemBars.ts).
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // Three-button navigation keeps the system's scrim, so its icons stay
        // readable at a side edge over the sidebar's ink in landscape.
        getWindow().setNavigationBarContrastEnforced(true);
        // Behind the WebView only; padded bars show the window background.
        findViewById(android.R.id.content).setBackgroundColor(Color.rgb(24, 25, 22));
    }
}
