-- Groups the product creates and keeps. A built-in group can be renamed and
-- its members and access changed, but not deleted. Only the Finance group a
-- new organization starts with is built in; the Admins group is computed
-- from member roles and has no row.
CREATE TABLE organization_builtin_group (
  team_id TEXT NOT NULL PRIMARY KEY
    REFERENCES "team" ("id") ON DELETE CASCADE,
  organization_id TEXT NOT NULL
    REFERENCES "organization" ("id") ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('finance')),
  UNIQUE (organization_id, kind)
);

-- Each organization's starting Finance group: the one migration 0010 made,
-- or the one sign-up created within a minute of the organization. Sign-up's
-- group is recognized by any sign of what it was made as, so a later rename
-- or revoked access does not hide it: it is still named Finance, still has
-- Finance access, or its recorded creation granted Finance. A team made with
-- the organization for another purpose shows none of these, and a later
-- group is the organization's own.
INSERT INTO organization_builtin_group (team_id, organization_id, kind)
SELECT candidate.team_id, candidate.organization_id, 'finance'
FROM (
  SELECT "team"."id" AS team_id, "organization"."id" AS organization_id,
         ROW_NUMBER() OVER (
           PARTITION BY "organization"."id"
           ORDER BY "team"."createdAt" ASC, "team"."id" ASC
         ) AS position
  FROM "organization"
  JOIN "team" ON "team"."organizationId" = "organization"."id"
  WHERE "team"."id" = 'team_finance_' || "organization"."id"
    OR (
      (julianday("team"."createdAt") - julianday("organization"."createdAt"))
        * 86400 BETWEEN 0 AND 60
      AND (
        "team"."name" = 'Finance'
        OR EXISTS (
          SELECT 1 FROM organization_group_capability AS access
          WHERE access.team_id = "team"."id" AND access.capability = 'finance'
        )
        OR EXISTS (
          SELECT 1 FROM activity_events AS created, json_each(
            json_extract(created.details, '$.capabilities')
          ) AS granted
          WHERE created.root_type = 'organization_group'
            AND created.root_id = "team"."id"
            AND created.action = 'organization.group_created'
            AND granted.value = 'finance'
        )
      )
    )
) AS candidate
WHERE candidate.position = 1;
