import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditDefinitionSchema } from "@balebase/validators/audits";
import residentialData from "../../auditLibrary/residential.json";
import { adminAuditTemplates } from "../admin/adminAuditTemplates";
import {
  createFixture,
  jsonRequest,
  legacyDatabase,
  type TemplateListResponse,
  type TemplateResponse,
} from "../testing/auditFixture";
import { testBindings } from "../testing/bindings";
import { toD1 } from "../testing/d1";
import { applyMigrations, createTestDatabase } from "../testing/database";
import { seedUser } from "../testing/seed";
import { testApp } from "../testing/session";
import {
  residentialLibraryStats,
  type StarterTemplate,
  seededStarterVersions,
  starterMigrationSql,
  starterSeedKey,
  starterTemplateSql,
  starterTemplates,
  validateResidentialLibrary,
} from "./auditLibrary";
import { audits } from "./audits";

const libraryActor = {
  email: "audit-library@system.invalid",
  id: "system:audit-library",
  name: "Stealth audit library",
};

describe("residential audit library", () => {
  it("keeps every control attributable and structurally valid", () => {
    expect(validateResidentialLibrary()).toEqual([]);
    for (const { definition } of starterTemplates()) {
      expect(AuditDefinitionSchema.parse(definition)).toEqual(definition);
    }
  });

  it("ships a substantial cross-trade residential baseline", () => {
    const stats = residentialLibraryStats();
    expect(stats.sections).toBe(19);
    expect(stats.controls).toBe(253);
    expect(stats.criticalControls).toBeGreaterThanOrEqual(50);
    expect(stats.sources).toBeGreaterThanOrEqual(25);
  });

  it("does not present the baseline as a code-compliance certification", () => {
    const residential = starterTemplates().find(
      ({ id }) => id === "us_residential_core_global",
    );
    expect(residential?.description).toContain(
      "not a code-compliance certification",
    );
    expect(residential?.description).toContain("State Plan");
    expect(residential?.description).toContain("local");
  });

  it("rejects data that breaks the schema or the content rules", () => {
    const edited = (edit: (library: typeof residentialData) => void) => {
      const library = structuredClone(residentialData);
      edit(library);
      return validateResidentialLibrary(library);
    };
    const editFirstControl = (fields: object) =>
      edited((library) => {
        Object.assign(library.sections[0]?.controls[0] ?? {}, fields);
      });

    expect(editFirstControl({ hazard: ["fall"] })).toEqual([
      expect.stringContaining('Unrecognized key: "hazard"'),
    ]);
    expect(editFirstControl({ hazards: ["falls"] })).toEqual([
      "Unknown taxonomy on res-ready-001: falls",
    ]);
    expect(editFirstControl({ risk: { stopWorkCandidate: true } })).toEqual([
      "Stop-work candidate is not critical: res-ready-001",
    ]);
    expect(
      editFirstControl({
        additionalSourceRefs: [
          { locator: "1926.20", sourceId: "osha-1926" },
          residentialData.sections[0]?.defaults.sourceRefs[0],
        ],
      }),
    ).toEqual([
      "Repeated source reference on res-ready-001",
      "Unknown source osha-1926 on res-ready-001",
    ]);
    expect(
      edited((library) => {
        const [source] = library.sources;
        if (source) source.url = "http://www.osha.gov/";
      }),
    ).toEqual(["Source URL must use HTTPS: osha-1926-general"]);
  });
});

describe("starter template seeding", () => {
  it("seeds each starter's current version with its generated SQL", () => {
    const directory = join(import.meta.dir, "../../migrations");
    const seeded = seededStarterVersions(
      readdirSync(directory)
        .filter((filename) => filename.endsWith(".sql"))
        .map((filename) => ({
          filename,
          sql: readFileSync(join(directory, filename), "utf8"),
        })),
    );
    for (const template of starterTemplates()) {
      // On failure, raise the template's version and run
      // `bun run --cwd packages/api audit-library:migration <name>`.
      expect(seeded.get(starterSeedKey(template))?.sql).toBe(
        starterTemplateSql(template),
      );
    }
  });

  it("serves each starter's current version on a fresh database", async () => {
    const database = createTestDatabase();
    const send = routesFor(database);
    const starters = starterTemplates();
    expect(starters.map(({ id }) => id)).toEqual([
      "nfpa70e_global",
      "us_residential_core_global",
    ]);
    const templates = starters.map((template) => ({
      // A family keeps the creation time of its first version.
      createdAt: database
        .query<{ created_at: string }, [string]>(
          "SELECT created_at FROM audit_template_families WHERE id = ?",
        )
        .get(template.id)?.created_at,
      currentVersion: template.version,
      definition: template.definition,
      description: template.description,
      id: template.id,
      name: template.name,
      savedAt: template.publishedAt,
      savedBy: libraryActor,
      scope: "global",
      status: "published",
      updatedAt: template.publishedAt,
      version: template.version,
    }));
    // Lists add how many audits each form has; none have started yet.
    const list = JSON.stringify({
      templates: templates
        .toSorted((first, second) =>
          second.updatedAt.localeCompare(first.updatedAt),
        )
        .map((template) => ({ ...template, auditCount: 0 })),
    });
    expect(await (await send("/templates")).text()).toBe(list);
    expect(await (await send("/admin/audit-templates", "admin")).text()).toBe(
      list,
    );
    for (const template of templates) {
      const detail = JSON.stringify({ template });
      for (const [path, role] of [
        [`/templates/${template.id}`, "user"],
        [`/templates/${template.id}/versions/${template.version}`, "user"],
        [`/admin/audit-templates/${template.id}`, "admin"],
      ] as const) {
        expect(await (await send(path, role)).text()).toBe(detail);
      }
      const versions = await send(`/templates/${template.id}/versions`);
      expect(
        ((await versions.json()) as { versions: unknown[] }).versions[0],
      ).toEqual({
        createdAt: template.savedAt,
        createdBy: libraryActor,
        version: template.version,
      });
    }
  });

  it("keeps starters that earlier releases seeded on request", () => {
    const database = createTestDatabase({ before: "0075" });
    const seededAt = "2026-09-01T12:00:00.000Z";
    const ids = starterTemplates().map(({ id }) => id);
    for (const id of ids) {
      database.run(
        `INSERT INTO audit_template_families
         (id, scope, organization_id, current_version, created_by,
          created_at, updated_at)
         VALUES (?, 'global', NULL, 1, 'system:audit-library', ?, ?)`,
        [id, seededAt, seededAt],
      );
      database.run(
        `INSERT INTO audit_template_versions
         (id, template_id, version, name, description, definition, status,
          created_by, created_at)
         VALUES (?, ?, 1, 'Seeded on request', '', '{}', 'published',
          'system:audit-library', ?)`,
        [`${id}:v1`, id, seededAt],
      );
    }
    const seeded = () => ({
      events: database
        .query(
          `SELECT root_id, action, occurred_at FROM activity_events
           WHERE root_type = 'audit_template' ORDER BY id`,
        )
        .all(),
      families: database
        .query("SELECT id, created_by, created_at FROM audit_template_families")
        .all(),
      versions: database
        .query("SELECT * FROM audit_template_versions WHERE version = 1")
        .all(),
    });
    const before = seeded();
    expect(before.events).toHaveLength(ids.length);

    applyMigrations(database, { from: "0075" });
    expect(seeded()).toEqual(before);
  });

  it("publishes a raised version through a generated migration", async () => {
    const [checklist] = starterTemplates() as [StarterTemplate];
    const next = checklist.version + 1;
    const revised = {
      ...checklist,
      name: `${checklist.name}, revised`,
      publishedAt: "2099-01-01T00:00:00.000Z",
      version: next,
    };
    const migration = starterMigrationSql([revised]);
    const database = createTestDatabase();
    runMigration(database, migration);

    const send = routesFor(database);
    expect(
      await (await send(`/templates/${checklist.id}`)).json(),
    ).toMatchObject({
      template: {
        currentVersion: next,
        name: revised.name,
        savedAt: revised.publishedAt,
        savedBy: libraryActor,
        version: next,
      },
    });
    const previous = `/templates/${checklist.id}/versions/${checklist.version}`;
    expect(await (await send(previous)).json()).toMatchObject({
      template: {
        currentVersion: next,
        name: checklist.name,
        version: checklist.version,
      },
    });

    // A tier where a root admin already saved that version keeps it.
    const edited = createTestDatabase();
    seedUser(edited, { id: "admin-1", role: "admin" });
    edited.run(
      `INSERT INTO audit_template_versions
       (id, template_id, version, name, description, definition, status,
        created_by, created_at)
       VALUES ('admin-save', ?, ?, 'Admin edit', '', ?, 'published',
        'admin-1', '2098-01-01T00:00:00.000Z')`,
      [checklist.id, next, JSON.stringify(checklist.definition)],
    );
    edited.run(
      "UPDATE audit_template_families SET current_version = ? WHERE id = ?",
      [next, checklist.id],
    );
    expect(() => runMigration(edited, migration)).toThrow("UNIQUE");
    expect(
      await (await routesFor(edited)(`/templates/${checklist.id}`)).json(),
    ).toMatchObject({ template: { name: "Admin edit", version: next } });
  });
});

describe("built-in templates", () => {
  it("attributes built-in templates to a durable system actor", async () => {
    const fixture = createFixture();
    const bookmarked = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates/us_residential_core_global",
      "GET",
    );
    expect(bookmarked.status).toBe(200);
    expect(bookmarked.body.template.name).toBe(
      "U.S. residential construction — comprehensive baseline",
    );

    const firstOrganization = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
    );
    expect(firstOrganization.status).toBe(200);

    const otherOrganization = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    const builtIns = otherOrganization.body.templates.filter(({ id }) =>
      ["nfpa70e_global", "us_residential_core_global"].includes(id),
    );
    expect(builtIns).toHaveLength(2);
    for (const template of builtIns) {
      expect(template.savedBy).toEqual({
        email: "audit-library@system.invalid",
        id: "system:audit-library",
        name: "Stealth audit library",
      });
    }
    expect(JSON.stringify(otherOrganization.body)).not.toContain(
      "person@example.com",
    );

    // Foreign keys are enforced, so a restricting reference would throw here.
    fixture.database.query("DELETE FROM user WHERE id = 'user-1'").run();
    expect(
      fixture.database.query("SELECT id FROM user WHERE id = 'user-1'").get(),
    ).toBeNull();
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count
           FROM audit_template_families
           WHERE id IN ('nfpa70e_global', 'us_residential_core_global')`,
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it("seeds the audit actor despite a public email collision", async () => {
    const database = legacyDatabase("0033");
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES ('collision-user', 'Collision User', ?, 1, ?, ?, 'user', 0)`,
      )
      .run(
        "audit-library@system.invalid",
        "2026-08-25T12:00:00.000Z",
        "2026-08-25T12:00:00.000Z",
      );

    applyMigrations(database, { before: "0034", from: "0033" });

    expect(
      database
        .query("SELECT id, email FROM user WHERE id = 'collision-user'")
        .get(),
    ).toEqual({
      email: "audit-library@system.invalid",
      id: "collision-user",
    });
    const actor = database
      .query("SELECT email, name FROM user WHERE id = 'system:audit-library'")
      .get() as { email: string; name: string };
    expect(actor.name).toBe("Stealth audit library");
    expect(actor.email).toStartWith("audit-library+");
    expect(actor.email).toEndWith("@system.invalid");
    expect(actor.email).not.toBe("audit-library@system.invalid");
  });

  it("consolidates organization starters into one global template", async () => {
    const database = legacyDatabase("0023");
    const definition = JSON.stringify({ sections: [], version: 1 });
    const insertFamily = database.query(
      `INSERT INTO audit_template_families
       (id, scope, organization_id, current_version, created_by, created_at,
        updated_at)
       VALUES (?, 'organization', ?, 1, ?, ?, ?)`,
    );
    const insertVersion = database.query(
      `INSERT INTO audit_template_versions
       (id, template_id, version, name, description, definition, status,
        created_by, created_at)
       VALUES (?, ?, 1, 'NFPA 70E readiness checklist', '', ?, 'published',
        ?, ?)`,
    );
    for (const [templateId, organizationId, userId] of [
      ["nfpa70e_org_user-1", "org_user-1", "user-1"],
      ["nfpa70e_org_user-2", "org_user-2", "user-2"],
    ] as const) {
      insertFamily.run(
        templateId,
        organizationId,
        userId,
        "2026-08-20T12:00:00.000Z",
        "2026-08-20T12:00:00.000Z",
      );
      insertVersion.run(
        `${templateId}:v1`,
        templateId,
        definition,
        userId,
        "2026-08-20T12:00:00.000Z",
      );
    }
    database
      .query(
        `INSERT INTO audits
         (id, organization_id, template_id, template_family_id,
          template_version_id, template_version, template_name, definition,
          responses, status, started_by, created_at, updated_at)
         VALUES ('starter-run', 'org_user-1', NULL, 'nfpa70e_org_user-1',
          'nfpa70e_org_user-1:v1', 1, 'NFPA 70E readiness checklist', ?, '{}',
          'in_progress', 'user-1', ?, ?)`,
      )
      .run(definition, "2026-08-21T12:00:00.000Z", "2026-08-21T12:00:00.000Z");

    applyMigrations(database, { before: "0034", from: "0023" });

    expect(
      database
        .query(
          `SELECT id, scope, organization_id, created_by
           FROM audit_template_families
           WHERE id GLOB 'nfpa70e_*'`,
        )
        .all(),
    ).toEqual([
      {
        created_by: "system:audit-library",
        id: "nfpa70e_global",
        organization_id: null,
        scope: "global",
      },
    ]);
    expect(
      database
        .query(
          `SELECT created_by
           FROM audit_template_versions
           WHERE id = 'nfpa70e_global:v1'`,
        )
        .get(),
    ).toEqual({ created_by: "system:audit-library" });
    expect(
      database
        .query(
          `SELECT template_family_id, template_version_id, template_version
           FROM audits WHERE id = 'starter-run'`,
        )
        .get(),
    ).toEqual({
      template_family_id: "nfpa70e_global",
      template_version: 1,
      template_version_id: "nfpa70e_global:v1",
    });
  });
});

function routesFor(database: Database) {
  const app = testApp(
    { "/admin/audit-templates": adminAuditTemplates, "/": audits },
    (context) => ({
      organizationId: "org-1",
      role: context.req.header("x-test-role") ?? "user",
    }),
  );
  const bindings = testBindings({ DB: toD1(database) });
  return (path: string, role = "user") =>
    app.request(path, { headers: { "x-test-role": role } }, bindings);
}

/** Applies generated SQL atomically, statement by statement, as D1 does. */
function runMigration(database: Database, sql: string) {
  database.transaction(() => {
    for (const statement of sql.split(/;$/m)) {
      if (statement.replace(/^--.*$/gm, "").trim()) database.run(statement);
    }
  })();
}
