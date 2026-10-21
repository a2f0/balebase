package com.balebase.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Capacitor's SystemBars plugin pads the window for system bars, cutouts,
        // and the keyboard; padding here as well doubles the keyboard's gap.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View content = findViewById(android.R.id.content);
        content.setBackgroundColor(Color.rgb(24, 25, 22));
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightNavigationBars(false);
    }
}
