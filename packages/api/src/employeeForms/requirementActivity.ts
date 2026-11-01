import { rowActivityStatement } from "../shared/activity";

type SqlCondition = { bindings: (string | number | null)[]; sql: string };

const personEmail = `COALESCE(
  (SELECT user.email FROM member JOIN user ON user.id = member.userId
   WHERE member.id = employee_requirements.member_id),
  (SELECT invitation.email FROM invitation
   WHERE invitation.id = employee_requirements.invitation_id),
  employee_requirements.target_email)`;
const personName = `(SELECT user.name FROM member JOIN user ON user.id = member.userId
  WHERE member.id = employee_requirements.member_id)`;

/** A JSON boolean for a SQL condition, for activity details. */
export function jsonBoolean(condition: string) {
  return `json(CASE WHEN ${condition} THEN 'true' ELSE 'false' END)`;
}

/**
 * Shared activity about a form or check requested of a person, snapshotting
 * the requirement and the person inside the batch. Only organization managers
 * read these events. Details never hold screening results, documents, or
 * consent contents.
 */
export function requirementActivityStatement(
  database: D1Database,
  input: {
    action: string;
    actorId: string;
    /** More `'key', value` pairs for the details object. */
    details?: SqlCondition;
    organizationId: string;
    requirementId: string;
  },
  condition?: SqlCondition,
) {
  const extra = input.details ? `, ${input.details.sql}` : "";
  return rowActivityStatement(
    database,
    {
      action: input.action,
      actorId: input.actorId,
      details: {
        bindings: input.details?.bindings ?? [],
        sql: `json_object('kind', kind, 'title', title,
          'personName', ${personName}, 'personEmail', ${personEmail}${extra})`,
      },
      id: input.requirementId,
      label: `title || ' · ' || COALESCE(NULLIF(${personName}, ''),
        ${personEmail}, 'Unknown person')`,
      occurredAt: new Date().toISOString(),
      organizationId: input.organizationId,
      rootType: "employee_requirement",
      table: "employee_requirements",
    },
    condition,
  );
}
