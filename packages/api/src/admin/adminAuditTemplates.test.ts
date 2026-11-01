import { describe, expect, it } from "bun:test";
import {
  type ActivityResponse,
  createFixture,
  jsonRequest,
  type RunResponse,
  type TemplateListResponse,
  type TemplateResponse,
  type TemplateVersionsResponse,
} from "../testing/auditFixture";
import { applyMigrations } from "../testing/database";

describe("global audit templates", () => {
  it("preserves legacy shared global forms when publication controls are introduced", async () => {
    const fixture = createFixture({ before: "0058" });
    const admin = { role: "admin" };
    const legacy = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "Legacy shared form" },
      admin,
    );
    const { id, definition, name } = legacy.body.template;
    await jsonRequest(
      fixture,
      `/admin/audit-templates/${id}`,
      "PUT",
      { definition, name },
      admin,
    );
    const local = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Organization draft" },
    );
    fixture.database
      .query(`INSERT INTO audits
      (id, organization_id, template_family_id, template_version_id,
       template_version, template_name, definition, responses, status,
       started_by, created_at, updated_at)
      SELECT 'legacy-audit', 'org_user-1', template_id, id, version, name,
        definition, '{}', 'in_progress', 'user-1', created_at, created_at
      FROM audit_template_versions WHERE template_id = ? AND version = 1`)
      .run(id);
    applyMigrations(fixture.database, { from: "0058" });
    const shared = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${id}`,
      "GET",
    );
    expect(shared.body.template).toMatchObject({
      id,
      name,
      status: "published",
      currentVersion: 2,
    });
    const versions = await jsonRequest<TemplateVersionsResponse>(
      fixture,
      `/templates/${id}/versions`,
      "GET",
    );
    expect(versions.body.versions.map(({ version }) => version)).toEqual([
      2, 1,
    ]);
    expect(
      (await jsonRequest(fixture, `/templates/${id}/versions/1`, "GET")).status,
    ).toBe(200);
    expect(
      (await jsonRequest(fixture, `/templates/${id}/runs`, "POST")).status,
    ).toBe(201);
    expect(
      (
        await jsonRequest(fixture, `/templates/${id}/copies`, "POST", {
          definition,
          name,
        })
      ).status,
    ).toBe(201);
    const existing = await jsonRequest(fixture, "/runs/legacy-audit", "GET");
    expect(existing.body).toMatchObject({
      audit: { templateId: id, templateVersion: 1 },
    });
    expect(
      (
        await jsonRequest(
          fixture,
          `/templates/${local.body.template.id}`,
          "GET",
        )
      ).body,
    ).toMatchObject({ template: { status: "draft" } });
    const fresh = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "New private draft" },
      admin,
    );
    expect(fresh.body.template).toMatchObject({ status: "draft" });
    expect(
      (
        await jsonRequest(
          fixture,
          `/templates/${fresh.body.template.id}`,
          "GET",
        )
      ).status,
    ).toBe(404);
  });

  it("shares only published versions and activity after publishing a global draft", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "Private draft title" },
      admin,
    );
    const { id, definition } = created.body.template;
    for (const [expectedCurrentVersion, name, status] of [
      [1, "Public form", "published"],
      [2, "Private unpublished title", "unpublished"],
      [3, "Public form again", "published"],
    ] as const) {
      expect(
        (
          await jsonRequest(
            fixture,
            `/admin/audit-templates/${id}`,
            "PUT",
            { definition, expectedCurrentVersion, name, status },
            admin,
          )
        ).status,
      ).toBe(200);
    }
    for (const version of [1, 3]) {
      expect(
        (
          await jsonRequest(
            fixture,
            `/templates/${id}/versions/${version}`,
            "GET",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await jsonRequest(
            fixture,
            `/admin/audit-templates/${id}/versions/${version}`,
            "GET",
            undefined,
            admin,
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (await jsonRequest(fixture, `/templates/${id}/versions/2`, "GET")).status,
    ).toBe(200);
    const shared = await jsonRequest<TemplateVersionsResponse>(
      fixture,
      `/templates/${id}/versions`,
      "GET",
    );
    expect(shared.body.versions.map(({ version }) => version)).toEqual([4, 2]);
    const managed = await jsonRequest<TemplateVersionsResponse>(
      fixture,
      `/admin/audit-templates/${id}/versions`,
      "GET",
      undefined,
      admin,
    );
    expect(managed.body.versions.map(({ version }) => version)).toEqual([
      4, 3, 2, 1,
    ]);
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/templates/${id}/activity`,
      "GET",
    );
    expect(
      history.body.events.map(({ details }) => Reflect.get(details, "version")),
    ).toEqual([4, 2]);
    expect(JSON.stringify(history.body)).not.toContain("Private");
    const adminHistory = await jsonRequest<ActivityResponse>(
      fixture,
      `/admin/audit-templates/${id}/activity`,
      "GET",
      undefined,
      admin,
    );
    expect(adminHistory.body.events).toHaveLength(4);
  });

  it("unpublishes global forms without losing history or existing audits", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const id = "nfpa70e_global";
    const current = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${id}`,
      "GET",
    );
    const run = await jsonRequest<RunResponse>(
      fixture,
      `/templates/${id}/runs`,
      "POST",
    );
    const save = (status: string, expectedCurrentVersion: number) =>
      jsonRequest<TemplateResponse>(
        fixture,
        `/admin/audit-templates/${id}`,
        "PUT",
        { ...current.body.template, status, expectedCurrentVersion },
        admin,
      );
    expect((await save("unpublished", 1)).body.template).toMatchObject({
      status: "unpublished",
      version: 2,
    });
    for (const [path, method] of [
      [`/templates/${id}`, "GET"],
      [`/templates/${id}/versions`, "GET"],
      [`/templates/${id}/versions/1`, "GET"],
      [`/templates/${id}/activity`, "GET"],
      [`/templates/${id}/runs`, "POST"],
      [`/templates/${id}/copies`, "POST"],
    ] as const) {
      expect((await jsonRequest(fixture, path, method)).status).toBe(404);
    }
    const listed = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
    );
    expect(listed.body.templates.map(({ id }) => id)).not.toContain(id);
    const managed = await jsonRequest<TemplateListResponse>(
      fixture,
      "/admin/audit-templates",
      "GET",
      undefined,
      admin,
    );
    expect(managed.body.templates.map(({ id }) => id)).toContain(id);
    const history = await jsonRequest<TemplateResponse>(
      fixture,
      `/admin/audit-templates/${id}/versions/1`,
      "GET",
      undefined,
      admin,
    );
    expect(history.body.template).toMatchObject({
      status: "published",
      version: 1,
    });
    const existing = await jsonRequest(
      fixture,
      `/runs/${run.body.auditId}`,
      "GET",
    );
    expect(existing.body).toMatchObject({
      audit: { templateId: id, templateVersion: 1 },
    });
    expect((await save("published", 1)).status).toBe(409);
    expect((await save("published", 2)).body.template).toMatchObject({
      status: "published",
      version: 3,
    });
    expect(
      (await jsonRequest(fixture, `/templates/${id}/runs`, "POST")).status,
    ).toBe(201);
    expect(
      (
        await jsonRequest(
          fixture,
          `/admin/audit-templates/${id}`,
          "DELETE",
          { expectedCurrentVersion: 3 },
          admin,
        )
      ).status,
    ).toBe(409);
  });

  it("discards an unpublished global form, but not a published one", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const global = await publishedGlobalTemplate(fixture);
    const { id } = global.body.template;
    const discard = (expectedCurrentVersion: number) =>
      jsonRequest(
        fixture,
        `/admin/audit-templates/${id}`,
        "DELETE",
        { expectedCurrentVersion },
        admin,
      );
    const published = await discard(2);
    expect(published.status).toBe(409);
    expect(published.body).toEqual({
      error:
        "Only draft or unpublished forms can be discarded. Unpublish this form first.",
    });
    await jsonRequest(
      fixture,
      `/admin/audit-templates/${id}`,
      "PUT",
      {
        ...global.body.template,
        expectedCurrentVersion: 2,
        status: "unpublished",
      },
      admin,
    );
    expect((await discard(2)).status).toBe(409);
    expect((await discard(3)).status).toBe(200);
    const listed = await jsonRequest<TemplateListResponse>(
      fixture,
      "/admin/audit-templates",
      "GET",
      undefined,
      admin,
    );
    expect(listed.body.templates.map((template) => template.id)).not.toContain(
      id,
    );
    expect(
      (
        await jsonRequest(
          fixture,
          `/admin/audit-templates/${id}`,
          "GET",
          undefined,
          admin,
        )
      ).status,
    ).toBe(404);
  });

  it("keeps global drafts private and discards them with a version guard", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "Private draft" },
      admin,
    );
    const { id } = created.body.template;
    expect((await jsonRequest(fixture, `/templates/${id}`, "GET")).status).toBe(
      404,
    );
    expect(
      (await jsonRequest(fixture, `/templates/${id}/runs`, "POST")).status,
    ).toBe(404);
    const saved = await jsonRequest(
      fixture,
      `/admin/audit-templates/${id}`,
      "PUT",
      {
        definition: created.body.template.definition,
        name: created.body.template.name,
        expectedCurrentVersion: 1,
      },
      admin,
    );
    expect(saved.body).toMatchObject({
      template: { status: "draft", version: 2 },
    });
    expect(
      (
        await jsonRequest(
          fixture,
          `/admin/audit-templates/${id}`,
          "DELETE",
          { expectedCurrentVersion: 1 },
          admin,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await jsonRequest(
          fixture,
          `/admin/audit-templates/${id}`,
          "DELETE",
          {},
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await jsonRequest(
          fixture,
          `/admin/audit-templates/${id}`,
          "DELETE",
          { expectedCurrentVersion: 2 },
          admin,
        )
      ).status,
    ).toBe(200);
    // A discarded form cannot be opened for editing, but root admins can
    // still read its versions and history until the purge
    // (discardedAuditForms.test.ts).
    for (const [suffix, status] of [
      ["", 404],
      ["/versions", 200],
      ["/versions/1", 200],
      ["/activity", 200],
    ] as const) {
      expect(
        (
          await jsonRequest(
            fixture,
            `/admin/audit-templates/${id}${suffix}`,
            "GET",
            undefined,
            admin,
          )
        ).status,
      ).toBe(status);
    }
    const listed = await jsonRequest<TemplateListResponse>(
      fixture,
      "/admin/audit-templates",
      "GET",
      undefined,
      admin,
    );
    expect(listed.body.templates.map(({ id }) => id)).not.toContain(id);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM audit_template_versions WHERE template_id = ?",
        )
        .get(id),
    ).toEqual({ count: 3 });
  });

  it("keeps global templates out of the organization create and update routes", async () => {
    const fixture = createFixture();
    for (const role of ["user", "admin"]) {
      const denied = await jsonRequest(
        fixture,
        "/templates",
        "POST",
        { name: "Organization-created global form", scope: "global" },
        { role },
      );
      expect(denied.status).toBe(400);
    }

    const global = await publishedGlobalTemplate(fixture);

    for (const role of ["user", "admin"]) {
      const deniedUpdate = await jsonRequest(
        fixture,
        `/templates/${global.body.template.id}`,
        "PUT",
        {
          definition: global.body.template.definition,
          expectedCurrentVersion: 2,
          name: "Organization safety form",
        },
        { role },
      );
      expect(deniedUpdate.status).toBe(403);
    }
  });

  it("shares a published global template, but no organization's own templates", async () => {
    const fixture = createFixture();
    const global = await publishedGlobalTemplate(fixture);
    expect(global.status).toBe(201);
    expect(global.body.template.scope).toBe("global");

    const local = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Private form", scope: "organization" },
    );
    expect(local.status).toBe(201);

    const otherOrganization = await jsonRequest<TemplateListResponse>(
      fixture,
      "/templates",
      "GET",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(otherOrganization.body.templates.map(({ name }) => name)).toContain(
      "Shared safety form",
    );
    expect(
      otherOrganization.body.templates.filter(
        ({ id }) => id === "nfpa70e_global",
      ),
    ).toHaveLength(1);
    expect(
      otherOrganization.body.templates.map(({ name }) => name),
    ).not.toContain("Private form");

    const privateRun = await jsonRequest(
      fixture,
      `/templates/${local.body.template.id}/runs`,
      "POST",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(privateRun.status).toBe(404);
  });

  it("copies a global template into an organization without changing it", async () => {
    const fixture = createFixture();
    const global = await publishedGlobalTemplate(fixture);

    const organizationCopy = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${global.body.template.id}/copies`,
      "POST",
      {
        definition: global.body.template.definition,
        expectedCurrentVersion: 2,
        name: "Organization safety form",
      },
    );
    expect(organizationCopy.status).toBe(201);
    expect(organizationCopy.body.template).toMatchObject({
      currentVersion: 1,
      name: "Organization safety form",
      scope: "organization",
      version: 1,
    });
    expect(organizationCopy.body.template.id).not.toBe(global.body.template.id);

    const unchangedGlobal = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${global.body.template.id}`,
      "GET",
    );
    expect(unchangedGlobal.body.template).toMatchObject({
      currentVersion: 2,
      name: "Shared safety form",
      scope: "global",
      version: 2,
    });

    const copiedRun = await jsonRequest(
      fixture,
      `/templates/${organizationCopy.body.template.id}/runs`,
      "POST",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(copiedRun.status).toBe(404);
  });

  it("starts other organizations' audits from the latest global version", async () => {
    const fixture = createFixture();
    const global = await publishedGlobalTemplate(fixture);

    const adminUpdate = await jsonRequest<TemplateResponse>(
      fixture,
      `/admin/audit-templates/${global.body.template.id}`,
      "PUT",
      {
        definition: global.body.template.definition,
        expectedCurrentVersion: 2,
        name: "Shared safety form v2",
      },
      { role: "admin" },
    );
    expect(adminUpdate.body.template).toMatchObject({
      currentVersion: 3,
      name: "Shared safety form v2",
      scope: "global",
      version: 3,
    });

    const globalRun = await jsonRequest<RunResponse>(
      fixture,
      `/templates/${global.body.template.id}/runs`,
      "POST",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(globalRun.status).toBe(201);
    const globalRunDetail = await jsonRequest(
      fixture,
      `/runs/${globalRun.body.auditId}`,
      "GET",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(globalRunDetail.body).toMatchObject({
      audit: {
        templateId: global.body.template.id,
        templateName: "Shared safety form v2",
        templateVersion: 3,
      },
    });
  });

  it("creates global templates with trimmed, required names and lists only global ones", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "  Shared ladder form  " },
      admin,
    );
    expect(created.status).toBe(201);
    expect(created.body.template).toMatchObject({
      currentVersion: 1,
      name: "Shared ladder form",
      scope: "global",
      version: 1,
    });
    const id = created.body.template.id;
    const invalid = await jsonRequest(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: " " },
      admin,
    );
    expect(invalid.status).toBe(400);

    const listed = await jsonRequest<TemplateListResponse>(
      fixture,
      "/admin/audit-templates",
      "GET",
      undefined,
      admin,
    );
    expect(listed.body.templates.map((template) => template.id)).toEqual(
      expect.arrayContaining([
        id,
        "nfpa70e_global",
        "us_residential_core_global",
      ]),
    );
    expect(listed.body.templates.every(({ scope }) => scope === "global")).toBe(
      true,
    );
  });

  it("hides organization templates from the admin console", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const local = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Private form" },
    );
    expect(local.body.template.scope).toBe("organization");

    for (const [path, method] of [
      [`/admin/audit-templates/${local.body.template.id}`, "GET"],
      [`/admin/audit-templates/${local.body.template.id}`, "PUT"],
      [`/admin/audit-templates/${local.body.template.id}/versions`, "GET"],
      [`/admin/audit-templates/${local.body.template.id}/versions/1`, "GET"],
      [`/admin/audit-templates/${local.body.template.id}/activity`, "GET"],
    ] as const) {
      const hidden = await jsonRequest(
        fixture,
        path,
        method,
        method === "PUT"
          ? {
              definition: local.body.template.definition,
              name: "Taken over",
            }
          : undefined,
        admin,
      );
      expect(hidden.status).toBe(404);
    }
  });

  it("versions a global template with a stale-write guard and shares the published version", async () => {
    const fixture = createFixture();
    const admin = { role: "admin" };
    const created = await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/audit-templates",
      "POST",
      { name: "  Shared ladder form  " },
      admin,
    );
    const id = created.body.template.id;

    const stale = await jsonRequest(
      fixture,
      `/admin/audit-templates/${id}`,
      "PUT",
      {
        definition: created.body.template.definition,
        expectedCurrentVersion: 2,
        name: "Shared ladder form v2",
      },
      admin,
    );
    expect(stale.status).toBe(409);
    const saved = await jsonRequest<TemplateResponse>(
      fixture,
      `/admin/audit-templates/${id}`,
      "PUT",
      {
        definition: created.body.template.definition,
        expectedCurrentVersion: 1,
        status: "published",
        name: "Shared ladder form v2",
      },
      admin,
    );
    expect(saved.body.template).toMatchObject({
      currentVersion: 2,
      name: "Shared ladder form v2",
      scope: "global",
      version: 2,
    });

    const versions = await jsonRequest<TemplateVersionsResponse>(
      fixture,
      `/admin/audit-templates/${id}/versions`,
      "GET",
      undefined,
      admin,
    );
    expect(versions.body.versions.map(({ version }) => version)).toEqual([
      2, 1,
    ]);
    const first = await jsonRequest<TemplateResponse>(
      fixture,
      `/admin/audit-templates/${id}/versions/1`,
      "GET",
      undefined,
      admin,
    );
    expect(first.body.template).toMatchObject({
      currentVersion: 2,
      name: "Shared ladder form",
      version: 1,
    });
    const badVersion = await jsonRequest(
      fixture,
      `/admin/audit-templates/${id}/versions/zero`,
      "GET",
      undefined,
      admin,
    );
    expect(badVersion.status).toBe(400);

    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/admin/audit-templates/${id}/activity`,
      "GET",
      undefined,
      admin,
    );
    expect(history.body.events.map(({ action }) => action)).toEqual([
      "audit.template_published",
      "audit.template_created",
    ]);
    const organizationView = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${id}`,
      "GET",
      undefined,
      { organizationId: "org_user-2", userId: "user-2" },
    );
    expect(organizationView.body.template.name).toBe("Shared ladder form v2");
  });
});

/** A global template the admin console created and published as version 2. */
async function publishedGlobalTemplate(
  fixture: ReturnType<typeof createFixture>,
) {
  const global = await jsonRequest<TemplateResponse>(
    fixture,
    "/admin/audit-templates",
    "POST",
    { name: "Shared safety form" },
    { role: "admin" },
  );
  await jsonRequest(
    fixture,
    `/admin/audit-templates/${global.body.template.id}`,
    "PUT",
    {
      ...global.body.template,
      expectedCurrentVersion: 1,
      status: "published",
    },
    { role: "admin" },
  );
  return global;
}
