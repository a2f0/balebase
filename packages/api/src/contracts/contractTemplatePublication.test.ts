import { describe, expect, it } from "bun:test";
import { contractTemplatesRoutes } from "@balebase/validators/contractTemplates";
import {
  createFixture,
  roleMapping,
  samplePdf,
  type Template,
  templateVersion,
  uploadTemplate,
} from "../testing/contractFixture";
import { applyMigrations, createTestDatabase } from "../testing/database";
import { sha256Hex } from "./contractPdf";
import { templatePublication } from "./contractTemplateDefinition";

const migration = "0103_contract_template_authoring.sql";

describe("contract template publication", () => {
  it("defines legal publication transitions and treats same-status saves as ordinary saves", () => {
    for (const status of ["draft", "published", "unpublished"] as const)
      expect(templatePublication(status, undefined)).toEqual({
        status,
        action: "contract_template.version_saved",
      });
    for (const status of ["published", "unpublished"] as const)
      expect(templatePublication(status, status)).toEqual({
        status,
        action: "contract_template.version_saved",
      });
    expect(templatePublication("draft", "unpublished")).toBeNull();
    expect(templatePublication("draft", "published")).toEqual({
      status: "published",
      action: "contract_template.published",
    });
    expect(templatePublication("published", "unpublished")).toEqual({
      status: "unpublished",
      action: "contract_template.unpublished",
    });
    expect(templatePublication("unpublished", "published")).toEqual({
      status: "published",
      action: "contract_template.published",
    });
  });

  it("requires current and selected publication, preserving immutable history and member saves", async () => {
    const fixture = createFixture();
    const first = await uploadTemplate(fixture);
    const path = `/api/contracts/templates/${first.id}`;
    const member = fixture.as("member-user", "org-1");
    expect(first).toMatchObject({
      status: "draft",
      currentStatus: "draft",
      authoring: null,
    });
    const input = templateVersion(first);
    expect(
      (await fixture.json("POST", `${path}/contracts`, roleMapping(1))).status,
    ).toBe(409);
    expect(
      (
        await fixture.json("POST", `${path}/versions`, {
          ...input,
          status: "unpublished",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await member.json("POST", `${path}/versions`, {
          ...input,
          status: "published",
        })
      ).status,
    ).toBe(403);
    const published = await fixture.json<{ template: Template }>(
      "POST",
      `${path}/versions`,
      {
        ...input,
        status: "published",
      },
    );
    expect(published.status).toBe(201);
    expect(published.body.template).toMatchObject({
      version: 2,
      status: "published",
      currentStatus: "published",
    });
    expect(
      (await fixture.json("POST", `${path}/contracts`, roleMapping(1))).status,
    ).toBe(409);
    const ordinary = await member.json<{ template: Template }>(
      "POST",
      `${path}/versions`,
      {
        ...templateVersion(published.body.template),
        status: "published",
      },
    );
    expect(ordinary.status).toBe(201);
    expect(ordinary.body.template.status).toBe("published");
    const historical = await fixture.json<{ contractId: string }>(
      "POST",
      `${path}/contracts`,
      roleMapping(2),
    );
    expect(historical.status).toBe(201);
    const unpublished = await fixture.json<{ template: Template }>(
      "POST",
      `${path}/versions`,
      {
        ...templateVersion(ordinary.body.template),
        status: "unpublished",
      },
    );
    expect(unpublished.status).toBe(201);
    expect(
      (await fixture.json("POST", `${path}/contracts`, roleMapping(2))).status,
    ).toBe(409);
    expect(
      (await fixture.json<{ template: Template }>("GET", `${path}?version=2`))
        .body.template,
    ).toEqual({
      ...published.body.template,
      currentVersion: 4,
      currentStatus: "unpublished",
    });
    const memberSave = await member.json<{ template: Template }>(
      "POST",
      `${path}/versions`,
      {
        ...templateVersion(unpublished.body.template),
        sourceVersion: 2,
      },
    );
    expect(memberSave.status).toBe(201);
    expect(memberSave.body.template.status).toBe("unpublished");
    expect(
      (
        await fixture.json("POST", `${path}/versions`, {
          ...templateVersion(memberSave.body.template),
          status: "published",
        })
      ).status,
    ).toBe(201);
    expect(
      (await fixture.json("POST", `${path}/contracts`, roleMapping(4))).status,
    ).toBe(409);
    expect(
      (await fixture.json("POST", `${path}/contracts`, roleMapping(2))).status,
    ).toBe(201);
    expect(
      (
        await fixture.request(
          `/api/contracts/${historical.body.contractId}/document`,
        )
      ).status,
    ).toBe(200);
    expect(
      fixture.database
        .query(
          "SELECT version, status FROM contract_template_versions ORDER BY version",
        )
        .all(),
    ).toEqual([
      { version: 1, status: "draft" },
      { version: 2, status: "published" },
      { version: 3, status: "published" },
      { version: 4, status: "unpublished" },
      { version: 5, status: "unpublished" },
      { version: 6, status: "published" },
    ]);
    expect(
      fixture.database
        .query(
          "SELECT action FROM activity_events WHERE root_type = 'contract_template' ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { action: "contract_template.created" },
      { action: "contract_template.published" },
      { action: "contract_template.version_saved" },
      { action: "contract_template.unpublished" },
      { action: "contract_template.version_saved" },
      { action: "contract_template.published" },
    ]);
  });

  it("rechecks manager authorization in the version insertion without advancing the family", async () => {
    const fixture = createFixture();
    const template = await uploadTemplate(fixture);
    const history = fixture.database
      .query("SELECT * FROM activity_events ORDER BY id")
      .all();
    fixture.hooks.before("INSERT INTO contract_template_versions", () => {
      fixture.database.exec(
        "UPDATE member SET role = 'member' WHERE userId = 'owner-user'",
      );
    });
    const result = await fixture.json(
      "POST",
      `/api/contracts/templates/${template.id}/versions`,
      {
        ...templateVersion(template),
        status: "published",
      },
    );
    expect(result.status).toBe(403);
    expect(
      fixture.database
        .query("SELECT current_version FROM contract_templates")
        .get(),
    ).toEqual({ current_version: 1 });
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM contract_template_versions")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.database.query("SELECT * FROM activity_events ORDER BY id").all(),
    ).toEqual(history);
    // The shared role predicate also supports combined Better Auth roles.
    fixture.database.exec(
      "UPDATE member SET role = 'member, admin' WHERE userId = 'owner-user'",
    );
    expect(
      (
        await fixture.json(
          "POST",
          `/api/contracts/templates/${template.id}/versions`,
          {
            ...templateVersion(template),
            status: "published",
          },
        )
      ).status,
    ).toBe(201);
  });

  it("rechecks both publication states atomically and deletes a refused copy", async () => {
    for (const selected of [false, true]) {
      const fixture = createFixture();
      const template = await uploadTemplate(fixture);
      const path = `/api/contracts/templates/${template.id}`;
      const published = await fixture.json<{ template: Template }>(
        "POST",
        `${path}/versions`,
        {
          ...templateVersion(template),
          status: "published",
        },
      );
      await fixture.json(
        "POST",
        `${path}/versions`,
        templateVersion(published.body.template),
      );
      fixture.hooks.before("INSERT INTO contracts", () => {
        // Simulate either status changing after the preflight read.
        fixture.database
          .query(
            "UPDATE contract_template_versions SET status = 'unpublished' WHERE template_id = ? AND version = ?",
          )
          .run(template.id, selected ? 2 : 3);
      });
      expect(
        (await fixture.json("POST", `${path}/contracts`, roleMapping(2)))
          .status,
      ).toBe(409);
      expect(
        fixture.database.query("SELECT COUNT(*) AS count FROM contracts").get(),
      ).toEqual({ count: 0 });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM contract_events")
          .get(),
      ).toEqual({ count: 0 });
      expect(fixture.stored.size).toBe(1);
    }
  });

  it("migrates all historical PDF versions as published and still copies them", async () => {
    const fixture = createFixture(createTestDatabase({ before: migration }));
    const bytes = await samplePdf();
    const hash = await sha256Hex(bytes);
    const definition = contractTemplatesRoutes.saveVersion.body.parse(
      templateVersion({ currentVersion: 1, version: 1 }),
    ).definition;
    fixture.database.exec(`INSERT INTO contract_templates
      (id, organization_id, current_version, created_at, updated_at)
      VALUES ('legacy', 'org-1', 2, '2026-01-01', '2026-01-01')`);
    for (const version of [1, 2]) {
      fixture.database
        .query(`INSERT INTO contract_template_versions
        (id, template_id, version, name, definition_json, document_object_key,
         document_filename, document_size, document_sha256, document_page_count, created_at)
        VALUES (?, 'legacy', ?, 'Legacy agreement', ?, 'legacy.pdf', 'Legacy.pdf', ?, ?, 2, '2026-01-01')`)
        .run(
          `legacy-${version}`,
          version,
          JSON.stringify(definition),
          bytes.byteLength,
          hash,
        );
    }
    await fixture.bindings.STORAGE.put("legacy.pdf", bytes);
    applyMigrations(fixture.database, { from: migration });
    for (const version of [1, 2]) {
      const detail = await fixture.json<{ template: Template }>(
        "GET",
        `/api/contracts/templates/legacy?version=${version}`,
      );
      expect(detail.body.template).toMatchObject({
        authoring: null,
        status: "published",
        currentStatus: "published",
      });
      expect(
        (
          await fixture.json(
            "POST",
            "/api/contracts/templates/legacy/contracts",
            roleMapping(version),
          )
        ).status,
      ).toBe(201);
    }
    const newTemplate = await uploadTemplate(fixture);
    expect(newTemplate.status).toBe("draft");
  });
});
