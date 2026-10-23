import { renderApp } from "@balebase/app/client";
import { configureBrowserDiagnostics } from "@balebase/diagnostics/browser";
import type { SentryBuild } from "@balebase/diagnostics/config";
import { initClickTracking } from "./clickTracking";

declare const __SENTRY_BUILD__: SentryBuild | undefined;

void configureBrowserDiagnostics(__SENTRY_BUILD__, "web").then(
  (diagnostics) => {
    renderApp({ captureError: diagnostics?.captureError });
    initClickTracking();
  },
);
