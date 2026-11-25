-- Background checks become their own capability, held by a built-in HR group
-- the way Finance is held by the built-in Finance group. Background checks
-- were owner- and admin-only, so each organization's HR group starts with
-- its current owners and admins and nobody loses access; later owners and
-- admins join it only when someone adds them.
--
-- SQLite cannot change a CHECK constraint in place, so the table that marks
-- built-in groups is rebuilt to accept the new kind. No trigger, view, or
-- foreign key refers to it.
CREATE TABLE organization_builtin_group_next (
  team_id TEXT NOT NULL PRIMARY KEY
    REFERENCES "team" ("id") ON DELETE CASCADE,
  organization_id TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('finance', 'hr')),
  UNIQUE (organization_id, kind)
);

INSERT INTO organization_builtin_group_next (team_id, organization_id, kind)
SELECT team_id, organization_id, kind FROM organization_builtin_group;

PRAGMA legacy_alter_table = ON;
DROP TABLE organization_builtin_group;
ALTER TABLE organization_builtin_group_next RENAME TO organization_builtin_group;
PRAGMA legacy_alter_table = OFF;

-- Group names are unique per organization, compared without case by the API;
-- an organization that already named a group HR keeps it as it is.
INSERT INTO "team" (
  "id", "name", "organizationId", "memberCount", "createdAt", "updatedAt"
)
SELECT
  'team_hr_' || "organization"."id",
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "team"
      WHERE "team"."organizationId" = "organization"."id"
        AND lower("team"."name") = 'hr'
    ) THEN 'HR (built-in)'
    ELSE 'HR'
  END,
  "organization"."id",
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM "organization";

INSERT INTO "teamMember" (
  "id", "teamId", "userId", "membershipKey", "createdAt"
)
SELECT
  'team_member_hr_' || "member"."id",
  'team_hr_' || "member"."organizationId",
  "member"."userId",
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM "member"
WHERE
  ',' || replace("member"."role", ' ', '') || ',' LIKE '%,owner,%'
  OR ',' || replace("member"."role", ' ', '') || ',' LIKE '%,admin,%';

UPDATE "team"
SET "memberCount" = (
  SELECT COUNT(*) FROM "teamMember" WHERE "teamMember"."teamId" = "team"."id"
)
WHERE "id" = 'team_hr_' || "organizationId";

INSERT INTO organization_group_capability (organization_id, team_id, capability)
SELECT "id", 'team_hr_' || "id", 'background_checks' FROM "organization";

INSERT INTO organization_builtin_group (team_id, organization_id, kind)
SELECT 'team_hr_' || "id", "id", 'hr' FROM "organization";

-- Each group's creation, as the activity feed records a group a person makes:
-- its name, members, and access. No person made these groups, so Balebase's
-- maintenance is the actor, named by this migration.
INSERT INTO activity_events (
  organization_id, root_type, root_id, root_label, subject_type, subject_id,
  action, actor_type, actor_source, actor_name, actor_email, occurred_at,
  details
)
SELECT
  "team"."organizationId", 'organization_group', "team"."id", "team"."name",
  'organization_group', "team"."id", 'organization.group_created', 'system',
  'createHrGroups', 'Balebase maintenance', '', "team"."createdAt",
  json_object(
    'name', "team"."name",
    'members', json((
      SELECT json_group_array(
        json_object('userId', person.id, 'name', person.name,
                    'email', person.email)
      )
      FROM (
        SELECT user.id, user.name, user.email
        FROM "teamMember" JOIN user ON user.id = "teamMember"."userId"
        WHERE "teamMember"."teamId" = "team"."id"
        ORDER BY user.name, user.id
      ) AS person
    )),
    'capabilities', json_array('background_checks')
  )
FROM "team"
JOIN organization_builtin_group AS builtin
  ON builtin.team_id = "team"."id" AND builtin.kind = 'hr';
