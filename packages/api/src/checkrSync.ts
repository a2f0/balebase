import type { Context } from "hono";
import { verifyCheckrWebhook } from "./checkr";
import {
  type CheckrAttemptRow,
  type CheckrScreeningRow,
  recoverCheckrAttempt,
  refreshCheckrScreening,
  reportSettleMs,
} from "./checkrScreening";
import { sendPendingScreeningNotifications } from "./screeningNotifications";
import type { Bindings } from "./types";
import { readWebhookPayload } from "./webhookPayload";

const maxCheckrWebhookBytes = 1024 * 1024;
const screeningRefreshLimit = 24;
// Checkr calls can take several seconds each, so refresh a few at a time.
const screeningRefreshConcurrency = 4;

interface CheckrEventSubject {
  candidateId: string | null;
  id: string;
}

// Checkr posts report events here. A verified event marks its screenings for
// refresh and is acknowledged at once, as Checkr asks; the refresh then reads
// the Checkr API, so duplicate or out-of-order deliveries settle on the
// current state. When that refresh fails, the mark keeps the screening in the
// hourly refresh below, even if it was already complete. An event for the
// candidate of an unfinished submission adopts its report at once.
export async function handleCheckrWebhook(
  context: Context<{ Bindings: Bindings }>,
) {
  const apiKey = context.env.CHECKR_API_KEY;
  if (!apiKey) {
    console.error("Checkr webhook verification is not configured.");
    return context.json({ error: "Webhook verification is unavailable." }, 503);
  }
  const payload = await readWebhookPayload(
    context.req.raw,
    maxCheckrWebhookBytes,
  );
  if (payload === null) {
    return context.json({ error: "Webhook payload is too large." }, 413);
  }
  const verified = await verifyCheckrWebhook(
    payload,
    context.req.header("x-checkr-signature"),
    apiKey,
  );
  if (!verified) {
    return context.json({ error: "Webhook signature is invalid." }, 400);
  }
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return context.json({ error: "Webhook payload is invalid." }, 400);
  }
  const subject = checkrEventSubject(event);
  if (subject === null) {
    return context.json({ error: "Webhook event is invalid." }, 400);
  }
  if (subject !== "ignored") {
    const screenings = await screeningsForEvent(
      context.env.DB,
      subject.id,
      subject.candidateId,
    );
    await requestScreeningRefreshes(context.env.DB, screenings);
    const attempts = subject.candidateId
      ? await attemptsForCandidate(context.env.DB, subject.candidateId)
      : [];
    context.executionCtx.waitUntil(
      Promise.all([
        refreshEventScreenings(context.env, screenings),
        ...attempts.map((attempt) =>
          recoverCheckrAttempt(context.env, attempt),
        ),
      ]).catch((cause) => {
        console.error("Could not apply a Checkr webhook event.", cause);
      }),
    );
  }
  return context.json({ received: true });
}

// Safety net for missed webhooks and failed refreshes: settles submissions
// their person left unfinished, then re-reads the least recently checked
// screenings that Checkr has not finished or that a webhook asked to refresh.
// Also retries completion emails and reports their delivery outcome to admins.
export async function refreshActiveCheckrScreenings(env: Bindings) {
  const notifications = await sendPendingScreeningNotifications(env);
  if (!env.CHECKR_API_KEY)
    return { refreshed: 0, skipped: true, notifications };
  const recovery = await recoverStaleAttempts(env);
  const { results } = await env.DB.prepare(
    `SELECT id, organization_id, status, checkr_report_id,
            checkr_report_status, checkr_refresh_revision
     FROM employee_requirements
     WHERE checkr_report_id IS NOT NULL
       AND (checkr_refresh_requested_at IS NOT NULL OR (
         status <> 'complete'
         AND (checkr_report_status IS NULL OR checkr_report_status NOT IN
                ('canceled', 'partially_canceled'))))
     ORDER BY checkr_checked_at ASC, updated_at ASC
     LIMIT ?`,
  )
    .bind(screeningRefreshLimit)
    .all<CheckrScreeningRow>();
  const failures: unknown[] = [...recovery.failures];
  let refreshed = recovery.settled;
  for (
    let index = 0;
    index < results.length;
    index += screeningRefreshConcurrency
  ) {
    const outcomes = await Promise.allSettled(
      results
        .slice(index, index + screeningRefreshConcurrency)
        .map((screening) => refreshCheckrScreening(env, screening)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
      else if (outcome.value) {
        refreshed += 1;
        notifications.sent += outcome.value.notifications.sent;
        notifications.failed += outcome.value.notifications.failed;
        notifications.abandoned += outcome.value.notifications.abandoned;
        notifications.queueUnavailable ||=
          outcome.value.notifications.queueUnavailable;
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Could not refresh ${failures.length} Checkr screening(s).`,
    );
  }
  return { refreshed, skipped: false, notifications };
}

// Attempts idle long enough that no report request can still arrive: their
// person may have lost a response or left the organization. Each recovery
// records checkr_checked_at, so attempts Checkr keeps failing on rotate out.
async function recoverStaleAttempts(env: Bindings) {
  const now = Date.now();
  const settled = new Date(now - reportSettleMs).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, organization_id, checkr_attempt_consent_id,
            checkr_candidate_id, checkr_report_requested_at, checkr_start_nonce
     FROM employee_requirements
     WHERE checkr_report_id IS NULL AND checkr_start_nonce IS NOT NULL
       AND (checkr_starting_at IS NULL OR checkr_starting_at < ?)
       AND checkr_start_nonce_at < ?
       AND (checkr_report_requested_at IS NULL
            OR checkr_report_requested_at < ?)
     ORDER BY checkr_checked_at ASC, checkr_start_nonce_at ASC
     LIMIT ?`,
  )
    .bind(
      new Date(now - 5 * 60_000).toISOString(),
      settled,
      settled,
      screeningRefreshLimit,
    )
    .all<CheckrAttemptRow>();
  const outcomes = await Promise.allSettled(
    results.map((attempt) => recoverCheckrAttempt(env, attempt)),
  );
  return {
    failures: outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    ),
    settled: outcomes.filter(
      (outcome) =>
        outcome.status === "fulfilled" &&
        (outcome.value === "adopted" || outcome.value === "cleared"),
    ).length,
  };
}

async function attemptsForCandidate(database: D1Database, candidateId: string) {
  const { results } = await database
    .prepare(
      `SELECT id, organization_id, checkr_attempt_consent_id,
              checkr_candidate_id, checkr_report_requested_at,
              checkr_start_nonce
       FROM employee_requirements
       WHERE checkr_report_id IS NULL AND checkr_start_nonce IS NOT NULL
         AND checkr_candidate_id = ?`,
    )
    .bind(candidateId)
    .all<CheckrAttemptRow>();
  return results;
}

async function refreshEventScreenings(
  env: Bindings,
  screenings: CheckrScreeningRow[],
) {
  for (const screening of screenings) {
    await refreshCheckrScreening(env, screening);
  }
}

// Keeps the latest request: a delayed write from an earlier event must not
// move the marker back before a refresh that has not seen a later event.
async function requestScreeningRefreshes(
  database: D1Database,
  screenings: CheckrScreeningRow[],
) {
  const requestedAt = new Date().toISOString();
  for (const screening of screenings) {
    await database
      .prepare(
        `UPDATE employee_requirements
         SET checkr_refresh_requested_at =
           MAX(COALESCE(checkr_refresh_requested_at, ?), ?)
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(requestedAt, requestedAt, screening.id, screening.organization_id)
      .run();
  }
}

function checkrEventSubject(
  event: unknown,
): CheckrEventSubject | "ignored" | null {
  if (!isRecord<"data" | "type">(event) || typeof event.type !== "string") {
    return null;
  }
  const data = event.data;
  const object = isRecord<"object">(data) ? data.object : undefined;
  if (
    !isRecord<"candidate_id" | "id">(object) ||
    typeof object.id !== "string" ||
    !object.id
  ) {
    return null;
  }
  if (!event.type.startsWith("report.")) return "ignored";
  return {
    candidateId:
      typeof object.candidate_id === "string" && object.candidate_id
        ? object.candidate_id
        : null,
    id: object.id,
  };
}

async function screeningsForEvent(
  database: D1Database,
  objectId: string,
  candidateId: string | null,
) {
  const { results } = await database
    .prepare(
      `SELECT id, organization_id, status, checkr_report_id,
              checkr_report_status, checkr_refresh_revision
       FROM employee_requirements
       WHERE checkr_report_id IS NOT NULL
         AND (checkr_report_id = ? OR checkr_candidate_id = ?)`,
    )
    .bind(objectId, candidateId)
    .all<CheckrScreeningRow>();
  return results;
}

function isRecord<Key extends string>(
  value: unknown,
): value is Partial<Record<Key, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
