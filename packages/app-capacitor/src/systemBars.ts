import {
  Capacitor,
  SystemBars,
  SystemBarsStyle,
  type SystemBarsStyleOptions,
  SystemBarType,
} from "@capacitor/core";

/**
 * Where Android draws the page under the system bars, the bars' icons follow
 * what the page paints behind them: light status icons over the ink band, and
 * navigation icons for the app's own theme, which can differ from the
 * system's. Capacitor writes the status bar's height to
 * `--safe-area-inset-top` on the root element. It is 0 on WebViews that keep
 * the page clear of the bars (before WebView 140); the bars then show the
 * window background, which follows the system theme, so they keep the
 * system's style.
 */
export function syncSystemBars(
  root = document.documentElement,
  bars: {
    setStyle(options: SystemBarsStyleOptions): Promise<void>;
  } = SystemBars,
) {
  if (Capacitor.getPlatform() !== "android") return;
  const applied = new Map<SystemBarType, SystemBarsStyle>();
  const apply = (bar: SystemBarType, style: SystemBarsStyle) => {
    if ((applied.get(bar) ?? SystemBarsStyle.Default) === style) return;
    applied.set(bar, style);
    void bars.setStyle({ bar, style });
  };
  const update = () => {
    const underBars =
      Number.parseFloat(root.style.getPropertyValue("--safe-area-inset-top")) >
      0;
    // Capacitor names styles for the background: Dark gives light icons.
    const pageStyle =
      root.getAttribute("data-theme") === "dark"
        ? SystemBarsStyle.Dark
        : SystemBarsStyle.Light;
    apply(
      SystemBarType.StatusBar,
      underBars ? SystemBarsStyle.Dark : SystemBarsStyle.Default,
    );
    apply(
      SystemBarType.NavigationBar,
      underBars ? pageStyle : SystemBarsStyle.Default,
    );
  };
  new MutationObserver(update).observe(root, {
    attributeFilter: ["data-theme", "style"],
  });
  update();
}
