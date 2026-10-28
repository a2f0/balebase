import { renderApp } from "@balebase/app/client";
import { startBrowserDiagnostics } from "@balebase/diagnostics/browser";
import { initClickTracking } from "@balebase/diagnostics/clickTracking";
import type { SentryBuild } from "@balebase/diagnostics/config";
import { WebUpdates } from "./WebUpdates";

declare const __SENTRY_BUILD__: SentryBuild | undefined;

const diagnostics = startBrowserDiagnostics(__SENTRY_BUILD__, "web");
renderApp(
  { captureError: diagnostics?.captureError },
  import.meta.env.PROD ? <WebUpdates /> : undefined,
);
initClickTracking({
  app: "web-app",
  origins: {
    production: "https://app.balebase.com",
    staging: "https://app-staging.balebase.com",
  },
  // Keep the default page "/". Click records must not reveal workspace
  // workflows, including screening, signing, finance, or admin activity.
});
