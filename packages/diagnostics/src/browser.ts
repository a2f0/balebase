import { BrowserClient, defaultStackParser, Scope } from "@sentry/browser";
import { privateDataCollection } from "./collectionPolicy";
import {
  browserConfig,
  type DiagnosticSource,
  isSentryBuild,
  type SentryBuild,
  type SentryConfig,
} from "./config";
import { fetchJsonWithTimeout } from "./fetch";
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
      else if (source === "boundary" || source === "uncaught-react")
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

async function configureBrowserDiagnostics(
  build: SentryBuild | undefined,
  target: string,
) {
  if (!isSentryBuild(build) || build.target !== target) return undefined;
  try {
    const manifest = await fetchJsonWithTimeout(
      new URL("/sentry-assets.json", window.location.href),
    );
    const config = browserConfig(
      build,
      manifest,
      `${window.location.protocol}//${window.location.host}`,
    );
    return config ? createBrowserDiagnostics(config) : undefined;
  } catch {
    return undefined;
  }
}

/** Start rendering immediately while a bounded manifest request configures reporting. */
export function startBrowserDiagnostics(
  build: SentryBuild | undefined,
  target: string,
) {
  if (!isSentryBuild(build) || build.target !== target) return undefined;
  let client: ReturnType<typeof createBrowserDiagnostics> | undefined;
  let waiting = true;
  const pending: Array<[unknown, DiagnosticSource]> = [];
  const captureError = (
    error: unknown,
    source: DiagnosticSource = "boundary",
  ) => {
    if (client) client.captureError(error, source);
    else if (waiting && pending.length < 20) pending.push([error, source]);
  };
  const onError = (event: ErrorEvent) =>
    captureError(event.error, "unhandled-error");
  const onRejection = (event: PromiseRejectionEvent) =>
    captureError(event.reason, "unhandled-rejection");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const ready = configureBrowserDiagnostics(build, target).then(
    (configured) => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      waiting = false;
      client = configured;
      for (const [error, source] of pending)
        client?.captureError(error, source);
      pending.length = 0;
      return client;
    },
  );
  return {
    captureError,
    flush: () => ready.then((configured) => configured?.flush() ?? false),
  };
}
