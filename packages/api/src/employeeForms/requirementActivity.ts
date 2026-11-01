import { type ActivityActor, rowActivityStatement } from "../shared/activity";
import {
  type SystemActor,
  systemActivityRowsStatement,
} from "../shared/systemActivity";

type SqlCondition = { bindings: (string | number | null)[]; sql: string };

const personEmail = `COALESCE(
  (SELECT user.email FROM member JOIN user ON user.id = member.userId
   WHERE member.id = employee_requirements.member_id),
  (SELECT invitation.email FROM invitation
   WHERE invitation.id = employee_requirements.invitation_id),
  employee_requirements.target_email)`;
const personName = `(SELECT user.name FROM member JOIN user ON user.id = member.userId
  WHERE member.id = employee_requirements.member_id)`;
const requirementLabel = `title || ' · ' || COALESCE(NULLIF(${personName}, ''),
  ${personEmail}, 'Unknown person')`;

/** A JSON boolean for a SQL condition, for activity details. */
export function jsonBoolean(condition: string) {
  return `json(CASE WHEN ${condition} THEN 'true' ELSE 'false' END)`;
}

function requirementDetails(details: SqlCondition | undefined) {
  const extra = details ? `, ${details.sql}` : "";
  return {
    bindings: details?.bindings ?? [],
    sql: `json_object('kind', kind, 'title', title,
      'personName', ${personName}, 'personEmail', ${personEmail}${extra})`,
  };
}

interface RequirementEvent {
  action: string;
  /** More `'key', value` pairs for the details object. */
  details?: SqlCondition;
  organizationId: string;
  requirementId: string;
}

/**
 * Shared activity about a form or check requested of a person, snapshotting
 * the requirement and the person inside the batch. Only organization managers
 * read these events. Details never hold screening results, documents, or
 * consent contents.
 */
export function requirementActivityStatement(
  database: D1Database,
  input: RequirementEvent & { actorId: string },
  condition?: SqlCondition,
) {
  return rowActivityStatement(
    database,
    {
      action: input.action,
      actorId: input.actorId,
      details: requirementDetails(input.details),
      id: input.requirementId,
      label: requirementLabel,
      occurredAt: new Date().toISOString(),
      organizationId: input.organizationId,
      rootType: "employee_requirement",
      table: "employee_requirements",
    },
    condition,
  );
}

/**
 * Who changed a screening: a person (with any API key they used), or Checkr
 * when its webhook or the scheduled refresh brought the change.
 */
export type ScreeningActor = ActivityActor | SystemActor;

/**
 * `requirementActivityStatement` for either kind of actor. A provider event
 * records nothing when its cause already recorded this action on the
 * requirement, so callers that must not change state without history gate
 * their write on `changes() > 0` right after it.
 */
export function screeningActivityStatement(
  database: D1Database,
  actor: ScreeningActor,
  input: RequirementEvent,
  condition: SqlCondition = { bindings: [], sql: "1 = 1" },
) {
  if (!("type" in actor)) {
    return requirementActivityStatement(
      database,
      { ...input, actorId: actor.userId },
      condition,
    );
  }
  const details = requirementDetails(input.details);
  return systemActivityRowsStatement(
    database,
    actor,
    new Date().toISOString(),
    {
      bindings: [
        input.action,
        ...details.bindings,
        input.requirementId,
        input.organizationId,
        ...condition.bindings,
      ],
      sql: `SELECT organization_id, 'employee_requirement' AS root_type,
                 id AS root_id, ${requirementLabel} AS root_label,
                 'employee_requirement' AS subject_type, id AS subject_id,
                 ? AS action, ${details.sql} AS details
          FROM employee_requirements
          WHERE id = ? AND organization_id = ? AND (${condition.sql})`,
    },
  );
}
