import { renderApp } from "@balebase/app/client";
import { startBrowserDiagnostics } from "@balebase/diagnostics/browser";
import type { SentryBuild } from "@balebase/diagnostics/config";
import { initClickTracking } from "./clickTracking";

declare const __SENTRY_BUILD__: SentryBuild | undefined;

const diagnostics = startBrowserDiagnostics(__SENTRY_BUILD__, "web");
renderApp({ captureError: diagnostics?.captureError });
initClickTracking();
