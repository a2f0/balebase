import { renderApp } from "@balebase/app/client";
import { configureBrowserDiagnostics } from "@balebase/diagnostics/browser";
import type { SentryBuild } from "@balebase/diagnostics/config";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { handleBackButton } from "./backButton";
import { capacitorHost } from "./host";
import { syncSystemBars } from "./systemBars";

declare const __SENTRY_BUILD__: SentryBuild | undefined;

handleBackButton();
syncSystemBars();
void configureBrowserDiagnostics(
  __SENTRY_BUILD__,
  Capacitor.getPlatform(),
).then((diagnostics) => {
  if (diagnostics) {
    void App.addListener("pause", () => {
      void diagnostics.flush();
    }).catch(() => undefined);
  }
  renderApp({
    ...capacitorHost(
      import.meta.env.VITE_APP_URL ?? "https://app.balebase.com",
    ),
    captureError: diagnostics?.captureError,
  });
});
