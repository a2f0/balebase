import { sendScreeningComplete } from "./screeningMail";
import type { Bindings } from "./types";

interface Notification {
  requirement_id: string;
  report_id: string;
  organization_id: string;
  organization_name: string;
  email: string;
  name: string;
  title: string;
}

// Recheck the report, organization, and original recipient at delivery time.
// Never fall back to an old address after a person leaves the organization.
const eligibleNotification = `
  FROM employee_screening_notifications AS notification
  JOIN employee_requirements AS requirement
    ON requirement.id = notification.requirement_id
    AND requirement.checkr_report_id = notification.report_id
  JOIN organization ON organization.id = requirement.organization_id
  JOIN member ON member.id = requirement.member_id
    AND member.organizationId = organization.id
    AND member.userId = notification.user_id
  JOIN user ON user.id = member.userId
  WHERE notification.sent_at IS NULL AND organization.deletedAt IS NULL
    AND requirement.status = 'complete'
    AND requirement.checkr_report_status = 'complete'`;

/** Deliver new completions and retry failed mail without changing report state. */
export async function sendPendingScreeningNotifications(
  env: Bindings,
  requirementId?: string,
) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT notification.requirement_id, notification.report_id
       ${eligibleNotification}
         AND notification.next_attempt_at <= ?
         AND (? IS NULL OR notification.requirement_id = ?)
       ORDER BY notification.next_attempt_at LIMIT 24`,
    )
      .bind(
        new Date().toISOString(),
        requirementId ?? null,
        requirementId ?? null,
      )
      .all<Pick<Notification, "requirement_id" | "report_id">>();
    for (const notification of results) {
      await deliverNotification(env, notification).catch((cause: unknown) => {
        console.error("Could not email a screening completion.", cause);
      });
    }
  } catch (cause) {
    console.error("Could not read pending screening notifications.", cause);
  }
}

async function deliverNotification(
  env: Bindings,
  notification: Pick<Notification, "requirement_id" | "report_id">,
) {
  const token = crypto.randomUUID();
  const now = new Date();
  const claim = await env.DB.prepare(
    `UPDATE employee_screening_notifications
     SET claim_token = ?, next_attempt_at = ?
     WHERE requirement_id = ? AND report_id = ?
       AND sent_at IS NULL AND next_attempt_at <= ?`,
  )
    .bind(
      token,
      new Date(now.getTime() + 5 * 60_000).toISOString(),
      notification.requirement_id,
      notification.report_id,
      now.toISOString(),
    )
    .run();
  if (!claim.meta.changes) return;
  const current = await env.DB.prepare(
    `SELECT notification.requirement_id, notification.report_id,
            requirement.organization_id, requirement.title,
            organization.name AS organization_name, user.email, user.name
     ${eligibleNotification} AND notification.claim_token = ?`,
  )
    .bind(token)
    .first<Notification>();
  if (!current) return;
  await sendScreeningComplete(env, {
    organizationId: current.organization_id,
    organizationName: current.organization_name,
    recipient: { email: current.email, name: current.name },
    requirementId: current.requirement_id,
    title: current.title,
  });
  // The provider has no idempotency key: a lost send response can cause a retry.
  await env.DB.prepare(
    `UPDATE employee_screening_notifications
     SET sent_at = ?, claim_token = NULL WHERE claim_token = ?`,
  )
    .bind(new Date().toISOString(), token)
    .run();
}
