import type { BackButtonListenerEvent } from "@capacitor/app";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

interface BackButtonApp {
  addListener(
    eventName: "backButton",
    listener: (event: BackButtonListenerEvent) => void,
  ): Promise<unknown>;
  minimizeApp(): Promise<void>;
}

/**
 * Android's Back steps back through the WebView's history, so the popstate
 * navigation guard still decides whether unsaved changes may be left. With
 * nothing to go back to, Back moves the app to the background, as it does at
 * the root of any Android 12+ app; the plugin alone would ignore it, leaving
 * Back unable to leave the app.
 */
export function handleBackButton(
  app: BackButtonApp = App,
  history: Pick<History, "back"> = window.history,
) {
  if (Capacitor.getPlatform() !== "android") return;
  void app.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) history.back();
    else void app.minimizeApp();
  });
}
