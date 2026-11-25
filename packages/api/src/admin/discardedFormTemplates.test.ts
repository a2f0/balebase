import { describe, expect, it } from "bun:test";
import { purgeDiscardedFormTemplates } from "../forms/discardedTemplatePurge";
import {
  type ActivityResponse,
  createFixture,
  jsonRequest,
  type TemplateListResponse,
  type TemplateResponse,
} from "../testing/formFixture";

const admin = { role: "admin", userId: "user-2" };
type Fixture = ReturnType<typeof createFixture>;

/** A global draft, saved as published then unpublished when asked. */
async function globalTemplate(
  fixture: Fixture,
  name: string,
  { unpublished = false } = {},
) {
  const created = await jsonRequest<TemplateResponse>(
    fixture,
    "/admin/form-templates",
    "POST",
    { name },
    admin,
  );
  let { template } = created.body;
  for (const status of unpublished ? ["published", "unpublished"] : []) {
    template = (
      await jsonRequest<TemplateResponse>(
        fixture,
        `/admin/form-templates/${template.id}`,
        "PUT",
        {
          ...template,
          expectedCurrentVersion: template.currentVersion,
          status,
        },
        admin,
      )
    ).body.template;
  }
  return template;
}

function discard(fixture: Fixture, id: string, expectedCurrentVersion: number) {
  return jsonRequest(
    fixture,
    `/admin/form-templates/${id}`,
    "DELETE",
    { expectedCurrentVersion },
    admin,
  );
}

function restore(fixture: Fixture, id: string, expectedCurrentVersion: number) {
  return jsonRequest<TemplateResponse>(
    fixture,
    `/admin/form-templates/${id}/restore`,
    "POST",
    { expectedCurrentVersion },
    admin,
  );
}

type ListedTemplate = TemplateListResponse["templates"][number] & {
  status: string;
};

async function listed(fixture: Fixture, view?: string) {
  const response = await jsonRequest<{ templates: ListedTemplate[] }>(
    fixture,
    `/admin/form-templates${view ? `?view=${view}` : ""}`,
    "GET",
    undefined,
    admin,
  );
  return response.body.templates;
}

/** Moves a template's discard, its current version's save time, to `at`. */
function discardedAt(fixture: Fixture, id: string, at: string) {
  fixture.database
    .query(
      `UPDATE form_template_versions SET created_at = ?
       WHERE template_id = ? AND version = (
         SELECT current_version FROM form_template_families WHERE id = ?
       )`,
    )
    .run(at, id, id);
}

describe("discarded global templates", () => {
  it("lists discarded templates separately and restores them with their earlier status", async () => {
    const fixture = createFixture();
    const draft = await globalTemplate(fixture, "Discarded draft");
    const unpublished = await globalTemplate(fixture, "Discarded unpublished", {
      unpublished: true,
    });
    expect((await discard(fixture, draft.id, 1)).status).toBe(200);
    expect((await discard(fixture, unpublished.id, 3)).status).toBe(200);

    const active = (await listed(fixture)).map(({ id }) => id);
    expect(active).not.toContain(draft.id);
    expect(active).not.toContain(unpublished.id);
    const discarded = await listed(fixture, "discarded");
    expect(discarded.map(({ id, status }) => [id, status])).toEqual(
      expect.arrayContaining([
        [draft.id, "discarded"],
        [unpublished.id, "discarded"],
      ]),
    );
    expect(discarded.find(({ id }) => id === draft.id)?.savedBy.id).toBe(
      "user-2",
    );
    expect(
      (
        await jsonRequest(
          fixture,
          "/admin/form-templates?view=bogus",
          "GET",
          undefined,
          admin,
        )
      ).status,
    ).toBe(400);

    // A restore from a stale listing changes nothing.
    expect((await restore(fixture, draft.id, 1)).status).toBe(409);
    const restoredDraft = await restore(fixture, draft.id, 2);
    expect(restoredDraft.status).toBe(200);
    expect(restoredDraft.body.template).toMatchObject({
      currentVersion: 3,
      name: "Discarded draft",
      status: "draft",
    });
    const restoredTemplate = await restore(fixture, unpublished.id, 4);
    expect(restoredTemplate.body.template).toMatchObject({
      currentVersion: 5,
      status: "unpublished",
    });
    expect((await listed(fixture)).map(({ id }) => id)).toEqual(
      expect.arrayContaining([draft.id, unpublished.id]),
    );
    expect(await listed(fixture, "discarded")).toEqual([]);

    // Only discarded templates can be restored.
    const again = await jsonRequest(
      fixture,
      `/admin/form-templates/${draft.id}/restore`,
      "POST",
      { expectedCurrentVersion: 3 },
      admin,
    );
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: "Only discarded templates can be restored.",
    });
    expect((await restore(fixture, "missing", 1)).status).toBe(404);

    // Organizations never see a restored template that is not published.
    expect(
      (await jsonRequest(fixture, `/templates/${unpublished.id}`, "GET"))
        .status,
    ).toBe(404);
  });

  it("records the discard and restore with the acting admin", async () => {
    const fixture = createFixture();
    const draft = await globalTemplate(fixture, "Tracked draft");
    await discard(fixture, draft.id, 1);
    await restore(fixture, draft.id, 2);
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/admin/form-templates/${draft.id}/activity`,
      "GET",
      undefined,
      admin,
    );
    expect(history.body.events).toHaveLength(3);
    expect(history.body.events).toMatchObject([
      {
        action: "form.template_restored",
        actor: { id: "user-2" },
        details: { version: 3 },
      },
      {
        action: "form.template_discarded",
        actor: { id: "user-2" },
        details: { version: 2 },
      },
      {
        action: "form.template_created",
        actor: { id: "user-2" },
        details: { version: 1 },
      },
    ]);
    // A save after the restore is an ordinary version again.
    await jsonRequest(
      fixture,
      `/admin/form-templates/${draft.id}`,
      "PUT",
      {
        definition: draft.definition,
        expectedCurrentVersion: 3,
        name: draft.name,
      },
      admin,
    );
    const latest = await jsonRequest<ActivityResponse>(
      fixture,
      `/admin/form-templates/${draft.id}/activity`,
      "GET",
      undefined,
      admin,
    );
    expect(latest.body.events[0]?.action).toBe("form.template_version_saved");
  });

  it("lets root admins read a discarded template's history and versions until the purge", async () => {
    const fixture = createFixture();
    const template = await globalTemplate(fixture, "Retained template", {
      unpublished: true,
    });
    expect((await discard(fixture, template.id, 3)).status).toBe(200);
    const read = (path: string, identity?: typeof admin) =>
      jsonRequest<
        ActivityResponse & {
          versions: Array<{ createdBy: { id: string }; version: number }>;
        }
      >(fixture, path, "GET", undefined, identity);

    const history = await read(
      `/admin/form-templates/${template.id}/activity`,
      admin,
    );
    expect(history.status).toBe(200);
    expect(
      history.body.events.map(({ action, actor }) => [action, actor.id]),
    ).toEqual([
      ["form.template_discarded", "user-2"],
      ["form.template_unpublished", "user-2"],
      ["form.template_published", "user-2"],
      ["form.template_created", "user-2"],
    ]);
    const versions = await read(
      `/admin/form-templates/${template.id}/versions`,
      admin,
    );
    expect(versions.status).toBe(200);
    expect(
      versions.body.versions.map(({ createdBy, version }) => [
        version,
        createdBy.id,
      ]),
    ).toEqual([
      [4, "user-2"],
      [3, "user-2"],
      [2, "user-2"],
      [1, "user-2"],
    ]);
    expect(
      (await read(`/admin/form-templates/${template.id}/versions/2`, admin))
        .body,
    ).toMatchObject({ template: { status: "published", version: 2 } });
    // It cannot be opened for editing, and organizations never see it.
    expect(
      (await read(`/admin/form-templates/${template.id}`, admin)).status,
    ).toBe(404);
    for (const suffix of ["/activity", "/versions", "/versions/2", ""])
      expect((await read(`/templates/${template.id}${suffix}`)).status).toBe(
        404,
      );

    // A restore is still recorded, and history reads on.
    const restored = await restore(fixture, template.id, 4);
    expect(restored.status).toBe(200);
    expect(
      (await read(`/admin/form-templates/${template.id}/activity`, admin)).body
        .events[0]?.action,
    ).toBe("form.template_restored");

    // Once purged, nothing remains to read.
    await discard(fixture, template.id, 5);
    discardedAt(fixture, template.id, "2026-01-01T00:00:00.000Z");
    expect(await purgeDiscardedFormTemplates(fixture.bindings, "run-1")).toBe(
      1,
    );
    for (const suffix of ["/activity", "/versions", "/versions/2"])
      expect(
        (await read(`/admin/form-templates/${template.id}${suffix}`, admin))
          .status,
      ).toBe(404);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE root_id = ?",
        )
        .get(template.id),
    ).toEqual({ count: 0 });
  });

  it("purges templates discarded at least 30 days ago, keeping forms and restored templates", async () => {
    const fixture = createFixture();
    const now = new Date("2026-10-30T12:00:00.000Z");
    const old = await globalTemplate(fixture, "Old discard", {
      unpublished: true,
    });
    const boundary = await globalTemplate(fixture, "Boundary discard");
    const recent = await globalTemplate(fixture, "Recent discard");
    const restored = await globalTemplate(fixture, "Restored discard");
    const kept = await globalTemplate(fixture, "Kept draft");
    await discard(fixture, old.id, 3);
    await discard(fixture, boundary.id, 1);
    await discard(fixture, recent.id, 1);
    await discard(fixture, restored.id, 1);
    discardedAt(fixture, old.id, "2026-09-01T00:00:00.000Z");
    discardedAt(fixture, boundary.id, "2026-09-30T12:00:00.000Z");
    discardedAt(fixture, recent.id, "2026-09-30T12:00:00.001Z");
    discardedAt(fixture, restored.id, "2026-09-01T00:00:00.000Z");
    expect((await restore(fixture, restored.id, 2)).status).toBe(200);
    fixture.database
      .query(`INSERT INTO forms
        (id, organization_id, project_id, template_family_id, template_version_id,
         template_version, template_name, definition, responses, status,
         started_by, created_at, updated_at)
        SELECT 'kept-form', 'org_user-1', 'project_org_user-1', template_id, id, version, name,
          definition, '{}', 'completed', 'user-1', created_at, created_at
        FROM form_template_versions WHERE template_id = ? AND version = 2`)
      .run(old.id);

    expect(
      await purgeDiscardedFormTemplates(fixture.bindings, "run-1", now),
    ).toBe(2);
    const families = fixture.database
      .query("SELECT id FROM form_template_families")
      .all()
      .map((row) => (row as { id: string }).id);
    expect(families).not.toContain(old.id);
    expect(families).not.toContain(boundary.id);
    expect(families).toEqual(
      expect.arrayContaining([recent.id, restored.id, kept.id]),
    );
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM form_template_versions WHERE template_id IN (?, ?)",
        )
        .get(old.id, boundary.id),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE root_type = 'form_template' AND root_id IN (?, ?)",
        )
        .get(old.id, boundary.id),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(
          "SELECT template_family_id, template_name FROM forms WHERE id = 'kept-form'",
        )
        .get(),
    ).toEqual({ template_family_id: null, template_name: "Old discard" });
    expect((await listed(fixture, "discarded")).map(({ id }) => id)).toEqual([
      recent.id,
    ]);
    expect((await restore(fixture, old.id, 4)).status).toBe(404);
    expect(
      await purgeDiscardedFormTemplates(fixture.bindings, "run-1", now),
    ).toBe(0);
  });

  it("never purges organization templates or templates that are not discarded", async () => {
    const fixture = createFixture();
    const local = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Organization template" },
    );
    const draft = await globalTemplate(fixture, "Old draft");
    for (const id of [local.body.template.id, draft.id])
      discardedAt(fixture, id, "2025-01-01T00:00:00.000Z");
    // Organization templates have no discard; mark one anyway to prove scope.
    fixture.database
      .query(
        "UPDATE form_template_versions SET status = 'discarded' WHERE template_id = ?",
      )
      .run(local.body.template.id);
    expect(await purgeDiscardedFormTemplates(fixture.bindings, "run-1")).toBe(
      0,
    );
  });

  it("reports a restore that loses the race to the purge as not found", async () => {
    const fixture = createFixture();
    const draft = await globalTemplate(fixture, "Racing discard");
    await discard(fixture, draft.id, 1);
    discardedAt(fixture, draft.id, "2026-01-01T00:00:00.000Z");
    let purged = false;
    // The purge commits between the restore's read and its save.
    fixture.hooks.onQuery = ({ sql }) => {
      if (purged || !sql.includes("UPDATE form_template_families")) return;
      purged = true;
      fixture.database
        .query("DELETE FROM form_template_families WHERE id = ?")
        .run(draft.id);
    };
    const response = await restore(fixture, draft.id, 2);
    expect(purged).toBe(true);
    expect(response.status).toBe(404);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM form_template_families WHERE id = ?",
        )
        .get(draft.id),
    ).toEqual({ count: 0 });
  });
});
