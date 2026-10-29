/**
 * Moves an invitation's employee requirements to the member who accepted it,
 * or to a renewed invitation. Better Auth's organization hooks in
 * `auth/auth.ts` call these, so they stay free of route and middleware imports.
 */
export async function assignAcceptedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  memberId: string,
) {
  const statement = database.prepare(
    `UPDATE employee_requirements
     SET invitation_id = NULL, member_id = ?,
         assigned_user_id = (SELECT userId FROM member WHERE id = ?),
         updated_at = ?
     WHERE organization_id = ? AND invitation_id = ?`,
  );
  const values = [
    memberId,
    memberId,
    new Date().toISOString(),
    organizationId,
    invitationId,
  ];
  await statement.bind(...values).run();
}

export async function assignRenewedInvitationRequirements(
  database: D1Database,
  organizationId: string,
  invitationId: string,
  email: string,
) {
  const statement = database.prepare(
    `UPDATE employee_requirements
     SET invitation_id = ?, updated_at = ?
     WHERE organization_id = ? AND member_id IS NULL
       AND assigned_user_id IS NULL
       AND target_email = ? COLLATE NOCASE
       AND (invitation_id IS NULL OR EXISTS (
         SELECT 1 FROM invitation AS old
         WHERE old.id = employee_requirements.invitation_id
           AND (old.status <> 'pending' OR old.expiresAt <= ?)
       ))`,
  );
  const values = [
    invitationId,
    new Date().toISOString(),
    organizationId,
    email,
    new Date().toISOString(),
  ];
  await statement.bind(...values).run();
}
