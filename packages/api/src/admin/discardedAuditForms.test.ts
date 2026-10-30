import { describe, expect, it } from "bun:test";
import { purgeDiscardedAuditForms } from "../audits/discardedTemplatePurge";
import {
  type ActivityResponse,
  createFixture,
  jsonRequest,
  type TemplateListResponse,
  type TemplateResponse,
} from "../testing/auditFixture";

const admin = { role: "admin", userId: "user-2" };
type Fixture = ReturnType<typeof createFixture>;

/** A global draft, saved as published then unpublished when asked. */
async function globalForm(
  fixture: Fixture,
  name: string,
  { unpublished = false } = {},
) {
  const created = await jsonRequest<TemplateResponse>(
    fixture,
    "/admin/audit-templates",
    "POST",
    { name },
    admin,
  );
  let { template } = created.body;
  for (const status of unpublished ? ["published", "unpublished"] : []) {
    template = (
      await jsonRequest<TemplateResponse>(
        fixture,
        `/admin/audit-templates/${template.id}`,
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
    `/admin/audit-templates/${id}`,
    "DELETE",
    { expectedCurrentVersion },
    admin,
  );
}

function restore(fixture: Fixture, id: string, expectedCurrentVersion: number) {
  return jsonRequest<TemplateResponse>(
    fixture,
    `/admin/audit-templates/${id}/restore`,
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
    `/admin/audit-templates${view ? `?view=${view}` : ""}`,
    "GET",
    undefined,
    admin,
  );
  return response.body.templates;
}

/** Moves a form's discard, its current version's save time, to `at`. */
function discardedAt(fixture: Fixture, id: string, at: string) {
  fixture.database
    .query(
      `UPDATE audit_template_versions SET created_at = ?
       WHERE template_id = ? AND version = (
         SELECT current_version FROM audit_template_families WHERE id = ?
       )`,
    )
    .run(at, id, id);
}

describe("discarded global forms", () => {
  it("lists discarded forms separately and restores them with their earlier status", async () => {
    const fixture = createFixture();
    const draft = await globalForm(fixture, "Discarded draft");
    const unpublished = await globalForm(fixture, "Discarded unpublished", {
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
          "/admin/audit-templates?view=bogus",
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
    const restoredForm = await restore(fixture, unpublished.id, 4);
    expect(restoredForm.body.template).toMatchObject({
      currentVersion: 5,
      status: "unpublished",
    });
    expect((await listed(fixture)).map(({ id }) => id)).toEqual(
      expect.arrayContaining([draft.id, unpublished.id]),
    );
    expect(await listed(fixture, "discarded")).toEqual([]);

    // Only discarded forms can be restored.
    const again = await jsonRequest(
      fixture,
      `/admin/audit-templates/${draft.id}/restore`,
      "POST",
      { expectedCurrentVersion: 3 },
      admin,
    );
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: "Only discarded forms can be restored.",
    });
    expect((await restore(fixture, "missing", 1)).status).toBe(404);

    // Organizations never see a restored form that is not published.
    expect(
      (await jsonRequest(fixture, `/templates/${unpublished.id}`, "GET"))
        .status,
    ).toBe(404);
  });

  it("records the discard and restore with the acting admin", async () => {
    const fixture = createFixture();
    const draft = await globalForm(fixture, "Tracked draft");
    await discard(fixture, draft.id, 1);
    await restore(fixture, draft.id, 2);
    const history = await jsonRequest<ActivityResponse>(
      fixture,
      `/admin/audit-templates/${draft.id}/activity`,
      "GET",
      undefined,
      admin,
    );
    expect(history.body.events).toHaveLength(3);
    expect(history.body.events).toMatchObject([
      {
        action: "audit.template_restored",
        actor: { id: "user-2" },
        details: { version: 3 },
      },
      {
        action: "audit.template_discarded",
        actor: { id: "user-2" },
        details: { version: 2 },
      },
      {
        action: "audit.template_created",
        actor: { id: "user-2" },
        details: { version: 1 },
      },
    ]);
    // A save after the restore is an ordinary version again.
    await jsonRequest(
      fixture,
      `/admin/audit-templates/${draft.id}`,
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
      `/admin/audit-templates/${draft.id}/activity`,
      "GET",
      undefined,
      admin,
    );
    expect(latest.body.events[0]?.action).toBe("audit.template_version_saved");
  });

  it("purges forms discarded at least 30 days ago, keeping audits and restored forms", async () => {
    const fixture = createFixture();
    const now = new Date("2026-10-30T12:00:00.000Z");
    const old = await globalForm(fixture, "Old discard", { unpublished: true });
    const boundary = await globalForm(fixture, "Boundary discard");
    const recent = await globalForm(fixture, "Recent discard");
    const restored = await globalForm(fixture, "Restored discard");
    const kept = await globalForm(fixture, "Kept draft");
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
      .query(`INSERT INTO audits
        (id, organization_id, template_family_id, template_version_id,
         template_version, template_name, definition, responses, status,
         started_by, created_at, updated_at)
        SELECT 'kept-audit', 'org_user-1', template_id, id, version, name,
          definition, '{}', 'completed', 'user-1', created_at, created_at
        FROM audit_template_versions WHERE template_id = ? AND version = 2`)
      .run(old.id);

    expect(await purgeDiscardedAuditForms(fixture.bindings, now)).toBe(2);
    const families = fixture.database
      .query("SELECT id FROM audit_template_families")
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
          "SELECT COUNT(*) AS count FROM audit_template_versions WHERE template_id IN (?, ?)",
        )
        .get(old.id, boundary.id),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE root_type = 'audit_template' AND root_id IN (?, ?)",
        )
        .get(old.id, boundary.id),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .query(
          "SELECT template_family_id, template_name FROM audits WHERE id = 'kept-audit'",
        )
        .get(),
    ).toEqual({ template_family_id: null, template_name: "Old discard" });
    expect((await listed(fixture, "discarded")).map(({ id }) => id)).toEqual([
      recent.id,
    ]);
    expect((await restore(fixture, old.id, 4)).status).toBe(404);
    expect(await purgeDiscardedAuditForms(fixture.bindings, now)).toBe(0);
  });

  it("never purges organization forms or forms that are not discarded", async () => {
    const fixture = createFixture();
    const local = await jsonRequest<TemplateResponse>(
      fixture,
      "/templates",
      "POST",
      { name: "Organization form" },
    );
    const draft = await globalForm(fixture, "Old draft");
    for (const id of [local.body.template.id, draft.id])
      discardedAt(fixture, id, "2025-01-01T00:00:00.000Z");
    // Organization forms have no discard; mark one anyway to prove scope.
    fixture.database
      .query(
        "UPDATE audit_template_versions SET status = 'discarded' WHERE template_id = ?",
      )
      .run(local.body.template.id);
    expect(await purgeDiscardedAuditForms(fixture.bindings)).toBe(0);
  });

  it("reports a restore that loses the race to the purge as not found", async () => {
    const fixture = createFixture();
    const draft = await globalForm(fixture, "Racing discard");
    await discard(fixture, draft.id, 1);
    discardedAt(fixture, draft.id, "2026-01-01T00:00:00.000Z");
    let purged = false;
    // The purge commits between the restore's read and its save.
    fixture.hooks.onQuery = ({ sql }) => {
      if (purged || !sql.includes("UPDATE audit_template_families")) return;
      purged = true;
      fixture.database
        .query("DELETE FROM audit_template_families WHERE id = ?")
        .run(draft.id);
    };
    const response = await restore(fixture, draft.id, 2);
    expect(purged).toBe(true);
    expect(response.status).toBe(404);
    expect(
      fixture.database
        .query(
          "SELECT COUNT(*) AS count FROM audit_template_families WHERE id = ?",
        )
        .get(draft.id),
    ).toEqual({ count: 0 });
  });
});
