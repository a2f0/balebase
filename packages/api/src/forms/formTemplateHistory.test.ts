import { describe, expect, it } from "bun:test";
import {
  type ActivityResponse,
  createFixture,
  jsonRequest,
  type TemplateResponse,
  type TestIdentity,
} from "../testing/formFixture";

type Fixture = ReturnType<typeof createFixture>;
type Template = TemplateResponse["template"];

const admin = { role: "admin", userId: "user-2" };

function templateEvents(fixture: Fixture, templateId: string) {
  return fixture.database
    .query(
      `SELECT action, actor_user_id AS actor, details FROM activity_events
       WHERE root_type = 'form_template' AND root_id = ? ORDER BY id`,
    )
    .all(templateId) as Array<{
    action: string;
    actor: string;
    details: string;
  }>;
}

function organizationTemplateCount(fixture: Fixture) {
  return fixture.database
    .query(
      `SELECT COUNT(*) AS count FROM form_template_families
       WHERE organization_id = 'org_user-1'`,
    )
    .get();
}

async function save(
  fixture: Fixture,
  template: Template,
  expectedCurrentVersion: number,
  changes: { description?: string; status?: string } = {},
  identity?: TestIdentity,
  path = `/templates/${template.id}`,
) {
  return jsonRequest<TemplateResponse>(
    fixture,
    path,
    "PUT",
    { ...template, status: undefined, ...changes, expectedCurrentVersion },
    identity,
  );
}

/** A global template saved with each status in turn by the root admin. */
async function globalTemplate(
  fixture: Fixture,
  name: string,
  statuses: string[],
) {
  let { template } = (
    await jsonRequest<TemplateResponse>(
      fixture,
      "/admin/form-templates",
      "POST",
      { name },
      admin,
    )
  ).body;
  for (const status of statuses) {
    template = (
      await save(
        fixture,
        template,
        template.currentVersion,
        { status },
        admin,
        `/admin/form-templates/${template.id}`,
      )
    ).body.template;
  }
  return template;
}

describe("template history", () => {
  it("records publishing and unpublishing apart from content saves", async () => {
    const fixture = createFixture();
    const { template } = (
      await jsonRequest<TemplateResponse>(fixture, "/templates", "POST", {
        name: "Site walk",
      })
    ).body;
    const edit = (version: number) => ({ description: `Edit ${version}` });

    expect((await save(fixture, template, 1, edit(1))).status).toBe(200);
    expect(
      (await save(fixture, template, 2, { status: "published" })).status,
    ).toBe(200);
    // A member's content save keeps the template published: no status change.
    expect(
      (await save(fixture, template, 3, edit(3), { userId: "user-2" })).status,
    ).toBe(200);
    // Saving with the status it already has is not a publication change.
    expect(
      (await save(fixture, template, 4, { status: "published" })).status,
    ).toBe(200);
    expect(
      (
        await save(
          fixture,
          template,
          5,
          { status: "unpublished" },
          { organizationRole: "admin", userId: "user-2" },
        )
      ).status,
    ).toBe(200);
    expect(
      (await save(fixture, template, 6, { status: "published" })).status,
    ).toBe(200);

    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/templates/${template.id}/activity`,
      "GET",
    );
    expect(
      history.body.events.map(({ action, actor, details }) => [
        action,
        actor.id,
        details,
      ]),
    ).toEqual([
      ["form.template_published", "user-1", { version: 7 }],
      ["form.template_unpublished", "user-2", { version: 6 }],
      ["form.template_version_saved", "user-1", { version: 5 }],
      ["form.template_version_saved", "user-2", { version: 4 }],
      ["form.template_published", "user-1", { version: 3 }],
      ["form.template_version_saved", "user-1", { version: 2 }],
      ["form.template_created", "user-1", { version: 1 }],
    ]);
    const feed = await jsonRequest<ActivityResponse>(
      fixture,
      "/activity?resourceType=form_template",
      "GET",
    );
    expect(feed.body.events.map(({ action }) => action).slice(0, 2)).toEqual([
      "form.template_published",
      "form.template_unpublished",
    ]);
  });

  it("records nothing for a denied, refused, or stale publication", async () => {
    const fixture = createFixture();
    const { template } = (
      await jsonRequest<TemplateResponse>(fixture, "/templates", "POST", {
        name: "Site walk",
      })
    ).body;
    const member = { organizationRole: "member", userId: "user-2" };
    expect(
      (await save(fixture, template, 1, { status: "published" }, member))
        .status,
    ).toBe(403);
    expect(
      (await save(fixture, template, 1, { status: "unpublished" })).status,
    ).toBe(409);
    expect(
      (await save(fixture, template, 1, { status: "published" })).status,
    ).toBe(200);
    expect(
      (await save(fixture, template, 1, { status: "unpublished" })).status,
    ).toBe(409);
    expect(
      templateEvents(fixture, template.id).map(({ action }) => action),
    ).toEqual(["form.template_created", "form.template_published"]);
  });

  it("rolls back a publication whose history cannot be written", async () => {
    const fixture = createFixture();
    const { template } = (
      await jsonRequest<TemplateResponse>(fixture, "/templates", "POST", {
        name: "Site walk",
      })
    ).body;
    fixture.database.exec(
      "CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END;",
    );
    const failed = await fixture.request(`/templates/${template.id}`, {
      body: JSON.stringify({
        ...template,
        expectedCurrentVersion: 1,
        status: "published",
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(failed.status).toBe(500);
    fixture.database.exec("DROP TRIGGER reject_activity");
    const current = await jsonRequest<TemplateResponse>(
      fixture,
      `/templates/${template.id}`,
      "GET",
    );
    expect(current.body.template).toMatchObject({
      currentVersion: 1,
      status: "draft",
    });
    expect(templateEvents(fixture, template.id)).toHaveLength(1);
  });

  it("shows a global template's publication to organizations but not its unpublication", async () => {
    const fixture = createFixture();
    const global = await globalTemplate(fixture, "Shared template", [
      "published",
      "unpublished",
      "published",
    ]);
    const adminHistory = await jsonRequest<ActivityResponse>(
      fixture,
      `/admin/form-templates/${global.id}/activity`,
      "GET",
      undefined,
      admin,
    );
    expect(adminHistory.body.events.map(({ action }) => action)).toEqual([
      "form.template_published",
      "form.template_unpublished",
      "form.template_published",
      "form.template_created",
    ]);
    const organizationHistory = await jsonRequest<ActivityResponse>(
      fixture,
      `/templates/${global.id}/activity`,
      "GET",
    );
    expect(
      organizationHistory.body.events.map(({ action, details }) => [
        action,
        details,
      ]),
    ).toEqual([
      ["form.template_published", { version: 4 }],
      ["form.template_published", { version: 2 }],
    ]);
  });
});

describe("copied template history", () => {
  it("names the published global template and version a copy came from", async () => {
    const fixture = createFixture();
    const global = await globalTemplate(fixture, "Shared template", [
      "published",
    ]);
    // Version 3 renames the template; the organization starts from version 2.
    await save(
      fixture,
      { ...global, name: "Shared template v3" },
      2,
      { status: "published" },
      admin,
      `/admin/form-templates/${global.id}`,
    );
    const copy = (body: Record<string, unknown>) =>
      jsonRequest<TemplateResponse>(
        fixture,
        `/templates/${global.id}/copies`,
        "POST",
        { definition: global.definition, name: "Our template", ...body },
        { userId: "user-2" },
      );
    const copied = await copy({ expectedCurrentVersion: 3, sourceVersion: 2 });
    expect(copied.status).toBe(201);
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/templates/${copied.body.template.id}/activity`,
      "GET",
    );
    expect(history.body.events).toHaveLength(1);
    expect(history.body.events[0]).toMatchObject({
      action: "form.template_created",
      actor: { id: "user-2" },
      details: {
        copiedFrom: {
          name: "Shared template",
          templateId: global.id,
          version: 2,
        },
        version: 1,
      },
    });
    const row = fixture.database
      .query(
        `SELECT copied_from_template_id, copied_from_version
         FROM form_template_versions WHERE template_id = ?`,
      )
      .get(copied.body.template.id);
    expect(row).toEqual({
      copied_from_template_id: global.id,
      copied_from_version: 2,
    });

    // Without a version, only the template is known: its current published name.
    const unversioned = await copy({});
    expect(
      templateEvents(fixture, unversioned.body.template.id).map(({ details }) =>
        JSON.parse(details),
      ),
    ).toEqual([
      {
        copiedFrom: {
          name: "Shared template v3",
          templateId: global.id,
          version: null,
        },
        version: 1,
      },
    ]);

    // A draft version stays private, so it cannot be a copy's source.
    const before = organizationTemplateCount(fixture);
    expect((await copy({ sourceVersion: 1 })).status).toBe(404);
    expect((await copy({ sourceVersion: 9 })).status).toBe(404);
    expect(organizationTemplateCount(fixture)).toEqual(before);

    // A blank template records no source.
    const blank = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Blank" },
    );
    expect(templateEvents(fixture, blank.body.template.id)[0]?.details).toBe(
      JSON.stringify({ version: 1 }),
    );
  });

  it("refuses to copy an unpublished or concurrently changed global template, recording nothing", async () => {
    const fixture = createFixture();
    const hidden = await globalTemplate(fixture, "Hidden template", [
      "published",
      "unpublished",
    ]);
    const copy = (id: string, definition: unknown) =>
      jsonRequest(fixture, `/templates/${id}/copies`, "POST", {
        definition,
        name: "Our template",
        sourceVersion: 2,
      });
    expect((await copy(hidden.id, hidden.definition)).status).toBe(404);

    const global = await globalTemplate(fixture, "Shared template", [
      "published",
    ]);
    fixture.hooks.before("AS sourceVersion", () => {
      // A root admin unpublishes the template while the copy is in flight.
      fixture.database
        .query(
          `INSERT INTO form_template_versions
           (id, template_id, version, name, description, definition, status,
            created_by, created_at)
           SELECT 'concurrent', template_id, 3, name, description, definition,
                  'unpublished', created_by, created_at
           FROM form_template_versions WHERE template_id = ? AND version = 2`,
        )
        .run(global.id);
      fixture.database
        .query(
          "UPDATE form_template_families SET current_version = 3 WHERE id = ?",
        )
        .run(global.id);
    });
    const before = organizationTemplateCount(fixture);
    const stale = await copy(global.id, global.definition);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: "This template has a newer version. Reload it before saving.",
    });
    expect(organizationTemplateCount(fixture)).toEqual(before);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count FROM activity_events
           WHERE organization_id = 'org_user-1' AND root_type = 'form_template'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back a copy whose history cannot be written", async () => {
    const fixture = createFixture();
    const global = await globalTemplate(fixture, "Shared template", [
      "published",
    ]);
    const before = organizationTemplateCount(fixture);
    fixture.database.exec(
      "CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END;",
    );
    const failed = await fixture.request(`/templates/${global.id}/copies`, {
      body: JSON.stringify({
        definition: global.definition,
        name: "Our template",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(failed.status).toBe(500);
    expect(organizationTemplateCount(fixture)).toEqual(before);
  });
});
