import { BrowserClient, defaultStackParser, Scope } from "@sentry/browser";
import { privateDataCollection } from "./collectionPolicy";
import {
  browserConfig,
  type DiagnosticSource,
  isSentryBuild,
  type SentryBuild,
  type SentryConfig,
} from "./config";
import { fetchWithTimeout } from "./fetch";
import { sanitizeSentryEvent } from "./privacy";
import { createPrivateTransport } from "./transport";

export function createBrowserDiagnostics(config: SentryConfig) {
  const client = new BrowserClient({
    ...config,
    dist: config.environment,
    stackParser: defaultStackParser,
    transport: createPrivateTransport(config),
    integrations: [],
    traceLifecycle: "static",
    tracesSampleRate: 0,
    dataCollection: privateDataCollection(),
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeSend: (event) => sanitizeSentryEvent(event, config),
  });
  const scope = new Scope();
  scope.setClient(client);
  client.init();
  const captureError = (
    error: unknown,
    source: DiagnosticSource = "boundary",
  ) => {
    try {
      if (error instanceof Error)
        scope.captureException(error, {
          captureContext: { tags: { diagnostic_source: source } },
        });
      else if (source === "boundary")
        scope.captureEvent({
          tags: { diagnostic_source: source },
          exception: { values: [{ type: "Error" }] },
        });
    } catch {
      // Diagnostics never interrupt application behavior.
    }
  };
  const onError = (event: ErrorEvent) =>
    captureError(event.error, "unhandled-error");
  const onRejection = (event: PromiseRejectionEvent) =>
    captureError(event.reason, "unhandled-rejection");
  const flush = () => Promise.resolve(client.flush(2000)).catch(() => false);
  const onPageHide = () => {
    void flush();
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onPageHide);
  return {
    captureError,
    flush,
    dispose() {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("pagehide", onPageHide);
      return client.close(2000);
    },
  };
}

export async function configureBrowserDiagnostics(
  build: SentryBuild | undefined,
  target: string,
) {
  if (!isSentryBuild(build) || build.target !== target) return undefined;
  try {
    const response = await fetchWithTimeout(
      new URL("/sentry-assets.json", window.location.href),
      {},
      2000,
    );
    if (!response.ok) return undefined;
    const config = browserConfig(
      build,
      await response.json(),
      window.location.origin,
    );
    return config ? createBrowserDiagnostics(config) : undefined;
  } catch {
    return undefined;
  }
}
