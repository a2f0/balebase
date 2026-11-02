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
-- or the one sign-up created with Finance access within a minute of the
-- organization, even if renamed since. A later group of the same name is
-- the organization's own.
INSERT INTO organization_builtin_group (team_id, organization_id, kind)
SELECT (
  SELECT "team"."id" FROM "team"
  WHERE "team"."organizationId" = "organization"."id"
    AND (
      "team"."id" = 'team_finance_' || "organization"."id"
      OR (
        EXISTS (
          SELECT 1 FROM organization_group_capability AS access
          WHERE access.team_id = "team"."id" AND access.capability = 'finance'
        )
        AND (julianday("team"."createdAt") - julianday("organization"."createdAt"))
          * 86400 BETWEEN 0 AND 60
      )
    )
  ORDER BY "team"."createdAt" ASC, "team"."id" ASC
  LIMIT 1
), "organization"."id", 'finance'
FROM "organization"
WHERE EXISTS (
  SELECT 1 FROM "team"
  WHERE "team"."organizationId" = "organization"."id"
    AND (
      "team"."id" = 'team_finance_' || "organization"."id"
      OR (
        EXISTS (
          SELECT 1 FROM organization_group_capability AS access
          WHERE access.team_id = "team"."id" AND access.capability = 'finance'
        )
        AND (julianday("team"."createdAt") - julianday("organization"."createdAt"))
          * 86400 BETWEEN 0 AND 60
      )
    )
);
