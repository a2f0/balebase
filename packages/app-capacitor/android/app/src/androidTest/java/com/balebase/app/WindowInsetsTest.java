package com.balebase.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;

import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.webkit.WebView;
import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Hands the window known insets and checks where the WebView lands. WebView
 * 140 and later report safe-area insets, so Capacitor lets the page draw under
 * the system bars and cutouts and pad itself; older ones keep it clear of
 * them. Either way the WebView ends at the keyboard, not a keyboard's height
 * above it.
 */
@RunWith(AndroidJUnit4.class)
public class WindowInsetsTest {

    private static final int CUTOUT = 40;
    private static final int STATUS_BAR = 120;
    private static final int NAVIGATION_BAR = 60;
    private static final int KEYBOARD = 900;

    @Test
    public void pageAsksToDrawUnderTheSystemBars() throws InterruptedException {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertTrue(viewportFitsCover(scenario));
        }
    }

    @Test
    public void webViewEndsAtTheKeyboard() throws InterruptedException {
        int[] expected = drawsUnderBars() ? new int[] { 0, 0, 0, KEYBOARD } : new int[] { CUTOUT, STATUS_BAR, 0, KEYBOARD };
        assertArrayEquals(expected, webViewMargins(true));
    }

    @Test
    public void webViewHandlesTheSystemBarsWithoutTheKeyboard() throws InterruptedException {
        int[] expected = drawsUnderBars() ? new int[] { 0, 0, 0, 0 } : new int[] { CUTOUT, STATUS_BAR, 0, NAVIGATION_BAR };
        assertArrayEquals(expected, webViewMargins(false));
    }

    /**
     * Where the page stays clear of the bars, they show the window background,
     * and their icons must contrast with it in either system theme.
     */
    @Test
    public void barIconsContrastWithTheWindowBackground() throws InterruptedException {
        assumeFalse(drawsUnderBars());
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertTrue(viewportFitsCover(scenario));
            scenario.onActivity((activity) -> {
                View decor = activity.getWindow().getDecorView();
                boolean lightBackground = ColorUtils.calculateLuminance(((ColorDrawable) decor.getBackground()).getColor()) > 0.5;
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), decor);
                assertEquals(lightBackground, bars.isAppearanceLightStatusBars());
                assertEquals(lightBackground, bars.isAppearanceLightNavigationBars());
            });
        }
    }

    private static boolean drawsUnderBars() {
        String version = WebView.getCurrentWebViewPackage().versionName;
        return Integer.parseInt(version.split("\\.")[0]) >= 140;
    }

    /** Waits for index.html to add viewport-fit=cover, which Capacitor reads when the page commits. */
    private static boolean viewportFitsCover(ActivityScenario<MainActivity> scenario) throws InterruptedException {
        for (int attempt = 0; attempt < 50; attempt++) {
            AtomicReference<String> content = new AtomicReference<>();
            CountDownLatch done = new CountDownLatch(1);
            scenario.onActivity((activity) ->
                activity
                    .getBridge()
                    .getWebView()
                    .evaluateJavascript("document.querySelector('meta[name=\"viewport\"]')?.content", (value) -> {
                        content.set(value);
                        done.countDown();
                    })
            );
            done.await(1, TimeUnit.SECONDS);
            if (content.get() != null && content.get().contains("viewport-fit=cover")) return true;
            Thread.sleep(200);
        }
        return false;
    }

    /**
     * The WebView's distance from each window edge (left, top, right, bottom)
     * once the page has loaded. Insets and layout run in one main-thread pass,
     * so the system's own insets cannot arrive in between.
     */
    private static int[] webViewMargins(boolean keyboardVisible) throws InterruptedException {
        int[] margins = new int[4];
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertTrue(viewportFitsCover(scenario));
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
