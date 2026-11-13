import {
  type OrganizationInvitation,
  organizationSettingsRoutes,
} from "@balebase/validators/organizationSettings";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  activityBatch,
  insertActivity,
  requestActor,
} from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import { deleteBilledOrganization } from "./organizationDeletion";
import {
  canManageOrganization,
  isOrganizationOwner,
  listOrganizationMembers,
  requireManager,
  stillManages,
} from "./organizationMembers";
import { paidFeaturesEnabled } from "./paidFeatureAccess";

interface OrganizationRow {
  id: string;
  name: string;
}

const organizationSettings = new Hono<ApiEnv>();

organizationSettings.get("/current", async (context) =>
  respond(context, organizationSettingsRoutes.current, {
    paidFeaturesEnabled: await paidFeaturesEnabled(
      context.env.DB,
      context.get("organizationId"),
    ),
  }),
);

organizationSettings.patch("/current", requireManager(), async (context) => {
  const body = await readBody(
    context,
    organizationSettingsRoutes.updateCurrent,
    "A paid features enabled boolean is required.",
  );
  if (body instanceof Response) return body;
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const manages = stillManages(organizationId, actor.userId);
  const enabled = body.paidFeaturesEnabled ? 1 : 0;
  const database = context.env.DB;
  const [, updated] = await activityBatch(database, actor.apiKey, [
    database
      .prepare(
        `${insertActivity}
       SELECT organization.id, 'organization', organization.id, organization.name,
              'organization', organization.id, 'organization.paid_features_changed',
              actor.id, actor.name, actor.email, ?,
              json_object('before', json(CASE WHEN paid_features_enabled
                THEN 'true' ELSE 'false' END), 'after', json(?))
       FROM organization JOIN user AS actor ON actor.id = ?
       WHERE organization.id = ? AND paid_features_enabled <> ? AND ${manages.sql}`,
      )
      .bind(
        new Date().toISOString(),
        enabled ? "true" : "false",
        actor.userId,
        organizationId,
        enabled,
        ...manages.bindings,
      ),
    database
      .prepare(
        `UPDATE organization SET paid_features_enabled = ?
       WHERE id = ? AND ${manages.sql}`,
      )
      .bind(enabled, organizationId, ...manages.bindings),
    database
      .prepare(
        `UPDATE job_runs SET status = 'cancelled', finished_at = ?, lease_until = NULL
       WHERE organization_id = ? AND job_id = 'syncFinanceConnection'
         AND (status = 'queued' OR (status = 'running' AND lease_until <= ?))
         AND EXISTS (SELECT 1 FROM organization
           WHERE id = ? AND paid_features_enabled = 0)
         AND ${manages.sql}`,
      )
      .bind(
        new Date().toISOString(),
        organizationId,
        new Date().toISOString(),
        organizationId,
        ...manages.bindings,
      ),
  ]);
  if (!updated?.meta.changes) {
    return context.json(
      { error: "Organization manager access required." },
      403,
    );
  }
  return respond(context, organizationSettingsRoutes.updateCurrent, body);
});

organizationSettings.get("/organizations", async (context) => {
  const userId = context.get("authSession").user.id;
  const result = await context.env.DB.prepare(
    `SELECT organization.id, organization.name
     FROM organization
     JOIN member ON member.organizationId = organization.id
     WHERE member.userId = ? AND organization.deletedAt IS NULL
     ORDER BY member.createdAt ASC, member.id ASC`,
  )
    .bind(userId)
    .all<OrganizationRow>();
  return respond(context, organizationSettingsRoutes.organizations, {
    organizations: result.results,
  });
});

organizationSettings.get("/people", async (context) => {
  const organizationId = context.get("organizationId");
  const memberRole = context.get("organizationRole");
  const canManage = canManageOrganization(memberRole);
  const [members, invitations] = await Promise.all([
    listOrganizationMembers(context.env.DB, organizationId),
    canManage
      ? listPendingInvitations(context.env.DB, organizationId)
      : Promise.resolve([]),
  ]);
  const userId = context.get("authSession").user.id;
  return respond(context, organizationSettingsRoutes.people, {
    currentMemberId: members.find(({ user }) => user.id === userId)?.id ?? null,
    invitations,
    memberRole,
    members: canManage
      ? members
      : members.map(({ id, joinedAt, role, user }) => ({
          id,
          joinedAt,
          role,
          user,
        })),
  });
});

organizationSettings.patch(
  "/people/:memberId/two-factor-required",
  requireManager(),
  async (context) => {
    const body = await readBody(
      context,
      organizationSettingsRoutes.updateMemberTwoFactorRequirement,
      "A required boolean is required.",
    );
    if (body instanceof Response) return body;
    const organizationId = context.get("organizationId");
    const memberId = context.req.param("memberId") ?? "";
    const actor = requestActor(context);
    const required = body.required ? 1 : 0;
    const guard = stillManages(organizationId, actor.userId);
    const database = context.env.DB;
    // The event reads the stored flag in the same transaction, so a repeat
    // records nothing and concurrent changes each record their own transition.
    const [, updated] = await activityBatch(database, actor.apiKey, [
      database
        .prepare(
          `INSERT INTO activity_events (
             organization_id, root_type, root_id, root_label, subject_type,
             subject_id, action, actor_user_id, actor_name, actor_email,
             occurred_at, details
           )
           SELECT member.organizationId, 'organization_member', member.id,
                  affected.name, 'organization_member', member.id,
                  'organization.member_two_factor_requirement_changed',
                  actor.id, actor.name, actor.email, ?,
                  json_object(
                    'before', json(CASE WHEN member.twoFactorRequired
                                        THEN 'true' ELSE 'false' END),
                    'after', json(?),
                    'userId', affected.id, 'userName', affected.name,
                    'userEmail', affected.email)
           FROM member
           JOIN user AS affected ON affected.id = member.userId
           JOIN user AS actor ON actor.id = ?
           WHERE member.id = ? AND member.organizationId = ?
             AND member.twoFactorRequired <> ? AND ${guard.sql}`,
        )
        .bind(
          new Date().toISOString(),
          required ? "true" : "false",
          actor.userId,
          memberId,
          organizationId,
          required,
          ...guard.bindings,
        ),
      database
        .prepare(
          `UPDATE member SET twoFactorRequired = ?
           WHERE id = ? AND organizationId = ? AND ${guard.sql}`,
        )
        .bind(required, memberId, organizationId, ...guard.bindings),
    ]);
    if (!updated?.meta.changes) {
      const member = await database
        .prepare(`SELECT id FROM member WHERE id = ? AND organizationId = ?`)
        .bind(memberId, organizationId)
        .first<{ id: string }>();
      return member
        ? context.json({ error: "Organization manager access required." }, 403)
        : context.json({ error: "Organization member not found." }, 404);
    }
    return respond(
      context,
      organizationSettingsRoutes.updateMemberTwoFactorRequirement,
      { memberId, required: body.required },
    );
  },
);

organizationSettings.delete("/current", async (context) => {
  const organizationId = context.get("organizationId");
  const userId = context.get("authSession").user.id;
  if (!isOrganizationOwner(context.get("organizationRole"))) {
    return context.json(
      { error: "Only an organization owner can delete this organization." },
      403,
    );
  }

  const result = await deleteBilledOrganization(context, organizationId, {
    apiKey: context.get("apiKey"),
    userId,
    via: "owner",
  });
  if ("response" in result) return result.response;
  const { deletion } = result;
  if (!deletion) {
    return context.json({ error: "Organization was already deleted." }, 409);
  }
  return respond(context, organizationSettingsRoutes.deleteCurrent, deletion);
});

async function listPendingInvitations(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT id, email, role, status, expiresAt
       FROM invitation
       WHERE organizationId = ? AND status = 'pending'
       ORDER BY createdAt DESC`,
    )
    .bind(organizationId)
    .all<OrganizationInvitation>();
  return result.results;
}

export { organizationSettings };
