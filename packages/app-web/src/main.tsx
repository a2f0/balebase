import { renderApp } from "@balebase/app/client";
import { startBrowserDiagnostics } from "@balebase/diagnostics/browser";
import type { SentryBuild } from "@balebase/diagnostics/config";
import { initClickTracking } from "./clickTracking";

declare const __SENTRY_BUILD__: SentryBuild | undefined;

const diagnostics = startBrowserDiagnostics(__SENTRY_BUILD__, "web");
renderApp({ captureError: diagnostics?.captureError });
initClickTracking();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/offline-worker.js").catch(() => {
    // The offline screen reports shell readiness before claiming a download is ready.
  });
}
