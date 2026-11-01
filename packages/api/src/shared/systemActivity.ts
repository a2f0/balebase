import { productName } from "@balebase/ui/brand";
import {
  type ActivityProvider,
  activityProviderNames,
} from "@balebase/validators/rules";

/**
 * A change no person made: Balebase's maintenance (`system`, with the job's
 * ID as its source) or a provider (`provider`, such as Stripe). `causation`
 * names what caused it, such as the job run or the provider's event ID: it is
 * the deduplication boundary, so a redelivery records one event per cause,
 * action, root, and subject. Never use one for work a person asked for.
 */
export type SystemActor =
  | { causation: ActivityCausation; jobId: string; type: "system" }
  | {
      causation: ActivityCausation | null;
      provider: ActivityProvider;
      type: "provider";
    };

export interface ActivityCausation {
  id: string;
  /** Such as `job_run`, `stripe_event`, or `plaid_webhook`. */
  type: string;
}

/** The system actor of one maintenance job run. */
export function maintenanceActor(jobId: string, runId: string): SystemActor {
  return { causation: { id: runId, type: "job_run" }, jobId, type: "system" };
}

/** A provider's change, caused by `causation` (its event, or our request). */
export function providerActor(
  provider: ActivityProvider,
  causation: ActivityCausation | null,
): SystemActor {
  return { causation, provider, type: "provider" };
}

/**
 * The system source of what a signing link did: Balebase's signing workflow
 * records a signer's decline and a contract's completion, caused by the
 * contract's own event, which names the signer.
 */
const contractSigningSource = "contractSigning";

/** The signing workflow, as the actor of one contract event's outcome. */
export function contractSigningActor(contractEventId: string): SystemActor {
  return {
    causation: { id: contractEventId, type: "contract_event" },
    jobId: contractSigningSource,
    type: "system",
  };
}

/** The label stored with a system or provider event. */
function systemActorName(actor: SystemActor) {
  if (actor.type === "provider") return activityProviderNames[actor.provider];
  return actor.jobId === contractSigningSource
    ? `${productName} signing`
    : `${productName} maintenance`;
}

function systemActorBindings(actor: SystemActor) {
  return [
    actor.type,
    actor.type === "system" ? actor.jobId : actor.provider,
    systemActorName(actor),
    actor.causation?.type ?? null,
    actor.causation?.id ?? null,
  ];
}

/**
 * Records system or provider events, one per row of `events`, a SELECT that
 * returns `organization_id`, `root_type`, `root_id`, `root_label`,
 * `subject_type`, `subject_id`, `action`, and `details` (JSON text). Put it in
 * the same batch as the change, guarded by the same condition, so an event
 * exists only when the change commits. A cause already recorded for the same
 * action, root, and subject records nothing.
 */
export function systemActivityRowsStatement(
  database: D1Database,
  actor: SystemActor,
  occurredAt: string,
  events: { bindings: (string | number | null)[]; sql: string },
) {
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_type, actor_source, actor_name, actor_email,
         causation_type, causation_id, occurred_at, details
       )
       SELECT event.organization_id, event.root_type, event.root_id,
              event.root_label, event.subject_type, event.subject_id,
              event.action, ?, ?, ?, '', ?, ?, ?, event.details
       FROM (${events.sql}) AS event
       WHERE true
       ON CONFLICT DO NOTHING`,
    )
    .bind(...systemActorBindings(actor), occurredAt, ...events.bindings);
}

/**
 * `activityStatement` for a system or provider actor: one event, recorded
 * only when `condition` holds, in the same batch as the change.
 */
export function systemActivityStatement(
  database: D1Database,
  actor: SystemActor,
  input: {
    action: string;
    details: Record<string, unknown>;
    occurredAt: string;
    organizationId: string | null;
    root: { id: string; label: string; type: string };
    subject: { id: string; type: string };
  },
  condition: { bindings: (string | number | null)[]; sql: string } = {
    bindings: [],
    sql: "1 = 1",
  },
) {
  return systemActivityRowsStatement(database, actor, input.occurredAt, {
    bindings: [
      input.organizationId,
      input.root.type,
      input.root.id,
      input.root.label,
      input.subject.type,
      input.subject.id,
      input.action,
      JSON.stringify(input.details),
      ...condition.bindings,
    ],
    sql: `SELECT ? AS organization_id, ? AS root_type, ? AS root_id,
                 ? AS root_label, ? AS subject_type, ? AS subject_id,
                 ? AS action, ? AS details
          WHERE ${condition.sql}`,
  });
}
