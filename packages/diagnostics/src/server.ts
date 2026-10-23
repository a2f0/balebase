import { createStackParser, Scope } from "@sentry/core";
import { nodeStackLineParser, ServerRuntimeClient } from "@sentry/core/server";
import { createSentryEventBudget } from "./budget";
import { privateDataCollection } from "./collectionPolicy";
import {
  type DiagnosticSource,
  isSentryBuild,
  type SentryBuild,
} from "./config";
import { sanitizeSentryEvent } from "./privacy";
import { createPrivateTransport } from "./transport";

const admit = createSentryEventBudget(60 * 60 * 1000);

/** A request owns its client and pending I/O; Workers cannot share I/O across requests. */
export async function captureServerError(
  build: SentryBuild | undefined,
  error: unknown,
  source: DiagnosticSource,
) {
  if (!isSentryBuild(build) || build.target !== "api") return;
  try {
    const config = { ...build, origin: "", paths: new Set(["/index.js"]) };
    const client = new ServerRuntimeClient({
      ...build,
      dist: build.environment,
      stackParser: createStackParser(nodeStackLineParser()),
      transport: createPrivateTransport(config, admit),
      integrations: [],
      traceLifecycle: "static",
      tracesSampleRate: 0,
      dataCollection: privateDataCollection(),
      sendClientReports: false,
      maxBreadcrumbs: 0,
      beforeSend: (event) => sanitizeSentryEvent(event, config),
    });
    client.init();
    const scope = new Scope();
    scope.setClient(client);
    scope.captureException(error instanceof Error ? error : new Error(), {
      captureContext: { tags: { diagnostic_source: source } },
    });
    await client.close(2000);
  } catch {
    // A failed report must preserve the original request/job outcome.
  }
}
