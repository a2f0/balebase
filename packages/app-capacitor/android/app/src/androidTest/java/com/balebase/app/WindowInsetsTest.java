package com.balebase.app;

import static org.junit.Assert.assertArrayEquals;

import android.graphics.Rect;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Hands the window known insets and checks where the WebView lands: clear of
 * the cutout and system bars, and ending at the keyboard rather than a
 * keyboard's height above it.
 */
@RunWith(AndroidJUnit4.class)
public class WindowInsetsTest {

    private static final int CUTOUT = 40;
    private static final int STATUS_BAR = 120;
    private static final int NAVIGATION_BAR = 60;
    private static final int KEYBOARD = 900;

    @Test
    public void webViewEndsAtTheKeyboard() {
        assertArrayEquals(new int[] { CUTOUT, STATUS_BAR, 0, KEYBOARD }, webViewMargins(true));
    }

    @Test
    public void webViewClearsTheSystemBarsWithoutTheKeyboard() {
        assertArrayEquals(new int[] { CUTOUT, STATUS_BAR, 0, NAVIGATION_BAR }, webViewMargins(false));
    }

    /**
     * The WebView's distance from each window edge (left, top, right, bottom).
     * Insets and layout run in one main-thread pass, so the system's own
     * insets cannot arrive in between.
     */
    private static int[] webViewMargins(boolean keyboardVisible) {
        int[] margins = new int[4];
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity((activity) -> {
                WindowInsetsCompat insets = new WindowInsetsCompat.Builder()
                    .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.of(CUTOUT, 0, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, STATUS_BAR, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, NAVIGATION_BAR))
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, keyboardVisible ? KEYBOARD : 0))
                    .setVisible(WindowInsetsCompat.Type.ime(), keyboardVisible)
                    .build();
                Rect window = activity.getWindowManager().getCurrentWindowMetrics().getBounds();
                View decor = activity.getWindow().getDecorView();
                decor.dispatchApplyWindowInsets(insets.toWindowInsets());
                decor.measure(
                    View.MeasureSpec.makeMeasureSpec(window.width(), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(window.height(), View.MeasureSpec.EXACTLY)
                );
                decor.layout(0, 0, window.width(), window.height());

                View webView = activity.getBridge().getWebView();
                int[] origin = new int[2];
                webView.getLocationInWindow(origin);
                margins[0] = origin[0];
                margins[1] = origin[1];
                margins[2] = window.width() - origin[0] - webView.getWidth();
                margins[3] = window.height() - origin[1] - webView.getHeight();
            });
        }
        return margins;
    }
}
