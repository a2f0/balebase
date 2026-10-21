import {
  Capacitor,
  SystemBars,
  SystemBarsStyle,
  type SystemBarsStyleOptions,
  SystemBarType,
} from "@capacitor/core";

/**
 * Where Android draws the page under the status bar, the page paints an ink
 * band behind it, so the bar takes light icons in either theme. Capacitor
 * writes the bar's height to `--safe-area-inset-top` on the root element; it
 * is 0 on WebViews that keep the page below the bar, which keep the system's
 * style.
 */
export function syncStatusBarStyle(
  root = document.documentElement,
  bars: {
    setStyle(options: SystemBarsStyleOptions): Promise<void>;
  } = SystemBars,
) {
  if (Capacitor.getPlatform() !== "android") return;
  let overInk = false;
  const update = () => {
    const inset = Number.parseFloat(
      root.style.getPropertyValue("--safe-area-inset-top"),
    );
    if (inset > 0 === overInk) return;
    overInk = inset > 0;
    void bars.setStyle({
      bar: SystemBarType.StatusBar,
      style: overInk ? SystemBarsStyle.Dark : SystemBarsStyle.Default,
    });
  };
  new MutationObserver(update).observe(root, { attributeFilter: ["style"] });
  update();
}
