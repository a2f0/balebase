import type { ClientOptions, ErrorEvent } from "@sentry/core";
import type { SentryConfig } from "./config";
import { sanitizeSentryEvent } from "./privacy";
import { createPrivateTransport } from "./transport";

/** Every client sends only sanitized, budgeted errors with no SDK extras. */
export function privateClientOptions(
  config: SentryConfig,
  admit?: (event: ErrorEvent) => boolean,
) {
  return {
    dist: config.environment,
    transport: createPrivateTransport(config, admit),
    integrations: [],
    traceLifecycle: "static",
    tracesSampleRate: 0,
    // Deny Sentry 11's expanded collection defaults before event sanitization.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeSend: (event) => sanitizeSentryEvent(event, config),
  } satisfies Partial<ClientOptions>;
}
