package com.balebase.app;

import android.graphics.Color;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Capacitor's SystemBars plugin pads the window for the keyboard, and for
        // system bars and cutouts unless the page draws under them; padding here
        // as well doubles the gaps. The page sets the bars' style (statusBar.ts).
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        findViewById(android.R.id.content).setBackgroundColor(Color.rgb(24, 25, 22));
    }
}
