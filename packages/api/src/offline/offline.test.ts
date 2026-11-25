import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import {
  type OfflineOperation,
  OfflineOperationSchema,
} from "@balebase/validators/offline";
import { testBindings } from "../testing/bindings";
import { queryHooks, toD1 } from "../testing/d1";
import { createTestDatabase } from "../testing/database";
import { requester } from "../testing/http";
import { seedAccount, seedMember } from "../testing/seed";
import { testApp } from "../testing/session";
import { offline } from "./offline";

const databases: Database[] = [];
const scope = { organizationId: "org_user-1", userId: "user-1" };
const definition = {
  version: 1,
  sections: [
    {
      id: "section",
      title: "Inspection",
      items: [
        { id: "check", prompt: "Safe?", required: true, responseType: "check" },
        { id: "notes", prompt: "Notes", required: false, responseType: "text" },
      ],
    },
  ],
};
const inspector = {
  email: "user-1@example.com",
  id: "user-1",
  name: "user-1",
};
const reviewer = { email: "user-2@example.com", id: "user-2", name: "user-2" };
/** A UTC time on the test day, `minute` minutes past noon. */
const at = (minute: number) =>
  `2026-11-10T12:${String(minute).padStart(2, "0")}:00.000Z`;

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it("starts the exact downloaded version once, then merges and completes it, recording each answer at its own time", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "fail", at: at(1) } });
  const results = await Promise.all([f.apply(start), f.apply(start)]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
  expect(results[0]?.body).toMatchObject({
    resourceId: start.id,
    form: {
      answers: { check: { at: at(1), value: "fail", version: start.id } },
      revision: 1,
      status: "in_progress",
    },
  });
  expect(f.form(start.id)).toEqual({
    answer_meta: JSON.stringify({
      check: { at: at(1), by: "user-1", v: start.id },
    }),
    responses: '{"check":"fail"}',
    revision: 1,
    status: "in_progress",
  });
  const save = formSave(
    start.id,
    { check: { value: "pass", at: at(5), base: start.id } },
    { complete: true },
  );
  expect(await f.apply(save)).toMatchObject({
    status: 201,
    body: {
      resourceId: start.id,
      form: {
        answers: { check: { at: at(5), value: "pass", version: save.id } },
      },
    },
  });
  expect(f.form(start.id)).toMatchObject({ status: "completed", revision: 2 });
  const history = f.db
    .query(
      "SELECT action, occurred_at FROM activity_events WHERE root_id = ? ORDER BY id",
    )
    .all(start.id) as { action: string; occurred_at: string }[];
  expect(
    history.map(({ action, occurred_at }) =>
      action === "form.answer_changed" ? [action, occurred_at] : action,
    ),
  ).toEqual([
    "form.started",
    ["form.answer_changed", at(1)],
    ["form.answer_changed", at(5)],
    "form.completed",
    "form.offline_synced",
  ]);
  expect((await f.apply(save)).status).toBe(200);
  expect(
    (
      await f.apply({
        ...save,
        answers: { check: { value: "fail", at: at(5), base: start.id } },
      })
    ).status,
  ).toBe(409);
  f.db.query("DELETE FROM forms WHERE id = ?").run(start.id);
  expect((await f.apply(start)).status).toBe(200);
  expect(f.db.query("SELECT id FROM forms").all()).toEqual([]);
});

it("merges answers last writer wins and records each collision with both answers", async () => {
  const f = fixture();
  const start = formStart({
    check: { value: "fail", at: at(1) },
    notes: { value: "Loose rail", at: at(1) },
  });
  expect((await f.apply(start)).status).toBe(201);
  // Online, someone answers the check after the device last synced.
  f.edit(start.id, "check", "na", at(3), "user-2");
  // The device's older answer to it loses; its note, which no one else
  // changed, applies without a conflict. Two tabs sending it apply it once.
  const first = formSave(start.id, {
    check: { value: "pass", at: at(2), base: start.id },
    notes: { value: "Rail fixed", at: at(4), base: start.id },
  });
  const results = await Promise.all([f.apply(first), f.apply(first)]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
  expect(results[0]?.body).toMatchObject({
    form: {
      answers: {
        check: { at: at(3), value: "na" },
        notes: { at: at(4), value: "Rail fixed" },
      },
    },
  });
  // A later answer the device gave without seeing the online one wins.
  const later = formSave(start.id, {
    check: { value: "fail", at: at(6), base: start.id },
  });
  expect((await f.apply(later)).status).toBe(201);
  // One given over the answer it saw, its own last save, is an ordinary
  // change.
  const ordinary = formSave(start.id, {
    check: { value: "pass", at: at(7), base: later.id },
  });
  expect((await f.apply(ordinary)).status).toBe(201);
  expect(f.form(start.id)).toMatchObject({
    responses: '{"check":"pass","notes":"Rail fixed"}',
  });
  expect(f.conflicts(start.id)).toEqual([
    {
      subject_id: "check",
      details: {
        prompt: "Safe?",
        responseType: "check",
        kept: { answeredAt: at(3), answeredBy: reviewer, value: "na" },
        discarded: { answeredAt: at(2), answeredBy: inspector, value: "pass" },
        reason: "later",
      },
    },
    {
      subject_id: "check",
      details: {
        prompt: "Safe?",
        responseType: "check",
        kept: { answeredAt: at(6), answeredBy: inspector, value: "fail" },
        discarded: { answeredAt: at(3), answeredBy: reviewer, value: "na" },
        reason: "later",
      },
    },
  ]);
});

it("keeps an answer cleared online over an older answer from a device", async () => {
  const f = fixture();
  const start = formStart({ notes: { value: "Loose rail", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  f.clear(start.id, "notes", at(3), "user-2");
  const save = formSave(start.id, {
    notes: { value: "Rail fixed", at: at(2), base: start.id },
  });
  expect(await f.apply(save)).toMatchObject({
    status: 201,
    body: { form: { answers: { notes: { at: at(3), value: null } } } },
  });
  expect(f.form(start.id)).toMatchObject({ responses: "{}" });
  expect(f.conflicts(start.id)).toEqual([
    {
      subject_id: "notes",
      details: {
        prompt: "Notes",
        responseType: "text",
        kept: { answeredAt: at(3), answeredBy: reviewer, value: null },
        discarded: {
          answeredAt: at(2),
          answeredBy: inspector,
          value: "Rail fixed",
        },
        reason: "later",
      },
    },
  ]);
});

it("keeps a completed form's answers and records the device's later ones as discarded", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "pass", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  f.db
    .query(
      "UPDATE forms SET status = 'completed', revision = revision + 1 WHERE id = ?",
    )
    .run(start.id);
  const save = formSave(
    start.id,
    {
      check: { value: "fail", at: at(5), base: start.id },
      notes: { value: "Too late", at: at(5), base: null },
    },
    { complete: true },
  );
  expect(await f.apply(save)).toMatchObject({
    status: 201,
    body: { form: { status: "completed", revision: 2 } },
  });
  expect(f.form(start.id)).toMatchObject({
    responses: '{"check":"pass"}',
    revision: 2,
  });
  expect(
    f
      .conflicts(start.id)
      .map(({ details, subject_id }) => [
        subject_id,
        details.kept?.value ?? null,
        details.discarded.value,
        details.reason,
      ]),
  ).toEqual([
    ["check", "pass", "fail", "completed"],
    ["notes", null, "Too late", "completed"],
  ]);
  expect((await f.apply(save)).status).toBe(200);
  expect(f.conflicts(start.id)).toHaveLength(2);
});

it("records collisions with more distinct people than D1 binds parameters", async () => {
  const f = fixture();
  // D1 refuses a statement with more than 100 bound parameters.
  let widest = 0;
  f.hooks.before(
    () => true,
    (event) => {
      widest = Math.max(widest, event.values.length);
    },
    { times: Number.POSITIVE_INFINITY },
  );
  const items = Array.from({ length: 101 }, (_, index) => `item-${index}`);
  f.addTemplate(
    "wide",
    // A section holds at most 100 items.
    [items.slice(0, 50), items.slice(50)].map((section, index) => ({
      id: `section-${index}`,
      title: "Wide",
      items: section.map((id) => ({
        id,
        prompt: id,
        required: false,
        responseType: "text",
      })),
    })),
  );
  const start = {
    ...formStart(
      Object.fromEntries(
        items.map((id) => [id, { value: "Device", at: at(1) }]),
      ),
    ),
    templateId: "wide",
  };
  expect((await f.apply(start)).status).toBe(201);
  // Each item is answered online by someone else after the device synced.
  for (const [index, id] of items.entries()) {
    seedAccount(f.db, { createdAt: "2026-10-01", id: `author-${index}` });
    f.edit(start.id, id, "Online", at(3), `author-${index}`);
  }
  const save = formSave(
    start.id,
    Object.fromEntries(
      items.map((id) => [id, { value: "Later", at: at(2), base: start.id }]),
    ),
  );
  expect((await f.apply(save)).status).toBe(201);
  expect(f.conflicts(start.id)).toHaveLength(101);
  expect(widest).toBeLessThanOrEqual(100);
});

it("merges and completes a template whose item IDs name inherited members", async () => {
  const f = fixture();
  f.addTemplate("inherited", [
    {
      id: "section",
      title: "Site",
      items: [
        {
          id: "constructor",
          prompt: "Exit clear?",
          required: true,
          responseType: "check",
        },
        {
          id: "toString",
          prompt: "Notes",
          required: false,
          responseType: "text",
        },
      ],
    },
  ]);
  const start = {
    ...formStart({ toString: { value: "Rail", at: at(1) } }),
    templateId: "inherited",
  };
  expect((await f.apply(start)).status).toBe(201);
  // The required item is still unanswered, so the completion does not apply.
  const save = formSave(
    start.id,
    { toString: { value: "Rail fixed", at: at(2), base: start.id } },
    { complete: true },
  );
  expect((await f.apply(save)).status).toBe(201);
  expect(f.form(start.id)).toMatchObject({
    responses: '{"toString":"Rail fixed"}',
    status: "in_progress",
  });
  const done = formSave(
    start.id,
    { constructor: { value: "pass", at: at(3), base: null } },
    { complete: true },
  );
  expect((await f.apply(done)).status).toBe(201);
  expect(f.form(start.id)).toMatchObject({ status: "completed" });
  expect(f.conflicts(start.id)).toEqual([]);
});

it("refuses a save to a discarded form and keeps no receipt", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "pass", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  f.db
    .query("UPDATE forms SET deleted_at = '2026-11-10' WHERE id = ?")
    .run(start.id);
  const save = formSave(start.id, {
    check: { value: "fail", at: at(5), base: start.id },
  });
  expect(await f.apply(save)).toMatchObject({
    status: 409,
    body: { error: expect.stringContaining("discarded") },
  });
  expect(f.db.query("SELECT id FROM offline_operations").all()).toEqual([
    { id: start.id },
  ]);
});

it("merges again over a write that lands between its read and its save", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "fail", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  f.hooks.before(
    /answer_meta = \?,\s+status = \?/,
    () => f.edit(start.id, "check", "na", at(9), "user-2"),
    { method: "batch" },
  );
  const save = formSave(start.id, {
    check: { value: "pass", at: at(5), base: start.id },
  });
  // The first merge applies nothing; the second finds the newer answer,
  // keeps it, and records the collision once.
  expect(await f.apply(save)).toMatchObject({
    status: 201,
    body: { form: { answers: { check: { at: at(9), value: "na" } } } },
  });
  expect(
    f
      .conflicts(start.id)
      .map(({ details }) => [details.kept?.value, details.discarded.value]),
  ).toEqual([["na", "pass"]]);
});

it("leaves a merge to the device's next sync while the form keeps changing", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "fail", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  let minute = 10;
  f.hooks.before(
    /answer_meta = \?,\s+status = \?/,
    () => {
      minute += 1;
      f.edit(start.id, "check", "na", at(minute), "user-2");
    },
    { method: "batch", times: 3 },
  );
  const save = formSave(start.id, {
    check: { value: "pass", at: at(30), base: start.id },
  });
  expect(await f.apply(save)).toMatchObject({
    status: 503,
    body: { error: expect.stringContaining("try again") },
  });
  expect(f.conflicts(start.id)).toEqual([]);
  expect(f.db.query("SELECT id FROM offline_operations").all()).toHaveLength(1);
  expect((await f.apply(save)).status).toBe(201);
  expect(f.form(start.id)).toMatchObject({ responses: '{"check":"pass"}' });
});

it("replays a save another tab commits while this one is being checked", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "fail", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  const save = formSave(start.id, {
    check: { value: "pass", at: at(5), base: start.id },
  });
  const digest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(OfflineOperationSchema.parse(save)))
    .digest("hex");
  // The other tab commits right after this request finds no receipt.
  f.hooks.after(
    "SELECT digest FROM offline_operations",
    () => {
      f.edit(start.id, "check", "pass", at(5), "user-1");
      f.db
        .query(
          "INSERT INTO offline_operations (organization_id, user_id, id, digest, created_at) VALUES (?, ?, ?, ?, '2026-11-10')",
        )
        .run(scope.organizationId, scope.userId, save.id, digest);
    },
    { method: "first" },
  );
  expect(await f.apply(save)).toMatchObject({
    status: 200,
    body: { resourceId: start.id },
  });
});

it("serves the device the server's copy of a form it holds", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "fail", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  f.edit(start.id, "notes", "Checked online", at(3), "user-2");
  const query = new URLSearchParams(scope);
  expect(await f.request("GET", `/forms/${start.id}?${query}`)).toMatchObject({
    status: 200,
    body: {
      answers: {
        check: { at: at(1), value: "fail", version: start.id },
        notes: { at: at(3), value: "Checked online" },
      },
      deleted: false,
      id: start.id,
      revision: 2,
      status: "in_progress",
    },
  });
  const other = new URLSearchParams({ ...scope, userId: "user-2" });
  expect((await f.request("GET", `/forms/${start.id}?${other}`)).status).toBe(
    403,
  );
  expect((await f.request("GET", `/forms/missing?${query}`)).status).toBe(404);
});

it("requires the parent form before its issue and does not duplicate issues on retry", async () => {
  const f = fixture();
  const parent = formStart();
  const issue: OfflineOperation = {
    id: crypto.randomUUID(),
    type: "issue",
    title: "Loose rail",
    description: "Staircase",
    priority: "high",
    assignedTo: null,
    formId: parent.id,
    itemId: "check",
  };
  expect((await f.apply(issue)).status).toBe(409);
  expect((await f.apply(parent)).status).toBe(201);
  expect((await f.apply(issue)).status).toBe(201);
  expect(await f.apply(issue)).toEqual(
    expect.objectContaining({ status: 200, body: { resourceId: issue.id } }),
  );
  expect(f.db.query("SELECT title, target_id FROM issues").all()).toEqual([
    { title: "Loose rail", target_id: parent.id },
  ]);
  expect(
    (await f.apply({ ...issue, id: crypto.randomUUID(), itemId: "missing" }))
      .status,
  ).toBe(409);
});

it("rejects wrong account and organization, invalid answers, and inaccessible templates without receipts", async () => {
  const f = fixture();
  expect(
    (await f.apply(formStart(), { ...scope, userId: "user-2" })).status,
  ).toBe(403);
  expect(
    (await f.apply(formStart(), { ...scope, organizationId: "org_user-2" }))
      .status,
  ).toBe(403);
  expect(
    (await f.apply(formStart({ check: { value: "invalid", at: at(1) } })))
      .status,
  ).toBe(409);
  expect(
    (await f.apply({ ...formStart(), templateId: "missing" })).status,
  ).toBe(409);
  expect((await f.apply({ ...formStart(), templateVersion: 300 })).status).toBe(
    409,
  );
  expect(f.db.query("SELECT id FROM offline_operations").all()).toEqual([]);
  expect(f.db.query("SELECT id FROM forms").all()).toEqual([]);
  // Saves need valid answers.
  const start = formStart();
  expect((await f.apply(start)).status).toBe(201);
  const invalid = { check: { value: "invalid", at: at(2), base: null } };
  expect((await f.apply(formSave(start.id, invalid))).status).toBe(409);
  expect(f.db.query("SELECT id FROM offline_operations").all()).toHaveLength(1);
});

it("saves a completion's answers but leaves the form in progress when a required answer is cleared elsewhere", async () => {
  const f = fixture();
  const start = formStart({ check: { value: "pass", at: at(1) } });
  expect((await f.apply(start)).status).toBe(201);
  f.clear(start.id, "check", at(3), "user-2");
  const save = formSave(
    start.id,
    {
      check: { value: "pass", at: at(2), base: start.id },
      notes: { value: "Done", at: at(2), base: null },
    },
    { complete: true },
  );
  expect(await f.apply(save)).toMatchObject({
    status: 201,
    body: {
      form: {
        answers: { check: { value: null }, notes: { value: "Done" } },
        status: "in_progress",
      },
    },
  });
  expect(
    f.db
      .query(
        "SELECT action FROM activity_events WHERE root_id = ? AND action IN ('form.completed', 'form.offline_synced')",
      )
      .all(start.id),
  ).toEqual([]);
});

interface Synced {
  changed: boolean;
  cursor: string;
  templates?: { id: string; version: number }[];
  members?: { id: string; name: string }[];
  projects?: {
    description: string;
    templateIds: string[];
    id: string;
    name: string;
  }[];
}

it("syncs the person's projects and their published templates by cursor", async () => {
  const f = fixture();
  const first = await f.sync();
  expect(first).toMatchObject({ changed: true, templates: [], projects: [] });
  expect(first.members?.map((person) => person.id)).toEqual(["user-1"]);
  expect(await f.sync(first.cursor)).toEqual({
    changed: false,
    cursor: first.cursor,
  });
  f.db.exec(`
    INSERT INTO projects (id, organization_id, name, created_at, updated_at)
    VALUES ('mine', 'org_user-1', 'Mine', '2026-10-01', '2026-10-01'),
           ('theirs', 'org_user-1', 'Theirs', '2026-10-01', '2026-10-01'),
           ('elsewhere', 'org_user-2', 'Elsewhere', '2026-10-01', '2026-10-01');
    INSERT INTO project_members (project_id, organization_id, user_id, added_at)
    VALUES ('mine', 'org_user-1', 'user-1', '2026-10-01'),
           ('theirs', 'org_user-1', 'user-2', '2026-10-01'),
           ('elsewhere', 'org_user-2', 'user-1', '2026-10-01');
    INSERT INTO form_template_families
      (id, scope, organization_id, current_version, created_by, created_at, updated_at)
    VALUES ('hidden', 'global', NULL, 1, 'user-1', '2026-10-01', '2026-10-01');
    INSERT INTO form_template_versions
      (id, template_id, version, name, description, definition, status, created_by, created_at)
    VALUES ('hidden-1', 'hidden', 1, 'Draft', '', '{}', 'draft', 'user-1', '2026-10-01');
    INSERT INTO project_form_templates (project_id, organization_id, template_id, added_at)
    VALUES ('mine', 'org_user-1', 'template', '2026-10-01'),
           ('mine', 'org_user-1', 'hidden', '2026-10-01'),
           ('mine', 'org_user-1', 'nfpa70e_global', '2026-10-01'),
           ('theirs', 'org_user-1', 'us_residential_core_global', '2026-10-01');
  `);
  const bound = await f.sync(first.cursor);
  expect(bound.cursor).not.toBe(first.cursor);
  // Not another member's project or organization, and not a draft: the
  // organization template's current version 2 is still a draft.
  expect(bound.projects).toEqual([
    {
      description: "",
      templateIds: ["nfpa70e_global"],
      id: "mine",
      name: "Mine",
    },
  ]);
  expect(bound.templates?.map((template) => template.id)).toEqual([
    "nfpa70e_global",
  ]);

  // Publishing a new version changes the cursor and serves that version.
  f.publish("template", 3, "published");
  const published = await f.sync(bound.cursor);
  expect(published.projects?.[0]?.templateIds.sort()).toEqual([
    "nfpa70e_global",
    "template",
  ]);
  expect(
    published.templates?.find((template) => template.id === "template")
      ?.version,
  ).toBe(3);

  // Unpublishing removes it; the set is whole, so it is simply absent.
  f.publish("template", 4, "unpublished");
  const unpublished = await f.sync(published.cursor);
  expect(unpublished.templates?.map((template) => template.id)).toEqual([
    "nfpa70e_global",
  ]);

  // Renaming the project, then removing the person, each change the set.
  f.db.exec("UPDATE projects SET name = 'Renamed' WHERE id = 'mine'");
  const renamed = await f.sync(unpublished.cursor);
  expect(renamed.projects?.map((project) => project.name)).toEqual(["Renamed"]);
  f.db.exec("DELETE FROM project_members WHERE user_id = 'user-1'");
  const removed = await f.sync(renamed.cursor);
  expect(removed).toMatchObject({ changed: true, templates: [], projects: [] });

  // Changes in another organization leave this cursor alone.
  f.db.exec("UPDATE projects SET name = 'Moved' WHERE id = 'elsewhere'");
  expect((await f.sync(removed.cursor)).changed).toBe(false);
  expect(
    (await f.request("GET", "/sync?userId=user-2&organizationId=org_user-1"))
      .status,
  ).toBe(403);
});

it("changes the cursor when global templates, membership, or names change", async () => {
  const f = fixture();
  f.db.exec(`
    INSERT INTO projects (id, organization_id, name, created_at, updated_at)
    VALUES ('mine', 'org_user-1', 'Mine', '2026-10-01', '2026-10-01');
    INSERT INTO project_members (project_id, organization_id, user_id, added_at)
    VALUES ('mine', 'org_user-1', 'user-1', '2026-10-01');
    INSERT INTO project_form_templates (project_id, organization_id, template_id, added_at)
    VALUES ('mine', 'org_user-1', 'nfpa70e_global', '2026-10-01');
  `);
  let cursor = (await f.sync()).cursor;
  const changes = [
    // A global template's new version.
    () => f.publish("nfpa70e_global", 0, "published"),
    // Someone joins, and is renamed.
    () =>
      seedMember(f.db, {
        createdAt: "2026-10-01",
        organizationId: "org_user-1",
        userId: "user-2",
      }),
    () => f.db.exec("UPDATE user SET name = 'Renamed' WHERE id = 'user-2'"),
    // The person leaves the organization: their projects no longer count.
    () =>
      f.db.exec(
        "DELETE FROM member WHERE userId = 'user-1' AND organizationId = 'org_user-1'",
      ),
  ];
  for (const change of changes) {
    change();
    const next = await f.sync(cursor);
    expect(next.changed).toBe(true);
    cursor = next.cursor;
  }
  expect(await f.sync(cursor)).toMatchObject({ changed: false });
  // Their membership was removed directly, so the sync reads as theirs but
  // lists nothing.
  const left = await f.sync();
  expect(left.projects).toEqual([]);
  expect(left.members?.map((person) => person.name)).toEqual(["Renamed"]);
});

it("records a form against its project, even one deleted since, and refuses any other", async () => {
  const f = fixture();
  f.db.exec(`
    INSERT INTO projects (id, organization_id, name, created_at, updated_at, deleted_at)
    VALUES ('deleted', 'org_user-1', 'Deleted', '2026-10-01', '2026-10-01', '2026-10-02'),
           ('elsewhere', 'org_user-2', 'Elsewhere', '2026-10-01', '2026-10-01', NULL);
  `);
  const onProject = formStart();
  const deleted = { ...formStart(), projectId: "deleted" };
  for (const operation of [onProject, deleted])
    expect((await f.apply(operation)).status).toBe(201);
  for (const projectId of ["elsewhere", "missing"])
    expect((await f.apply({ ...formStart(), projectId })).status).toBe(409);
  expect(
    f.db.query("SELECT id, project_id FROM forms ORDER BY project_id").all(),
  ).toEqual([
    { id: onProject.id, project_id: "audited" },
    { id: deleted.id, project_id: "deleted" },
  ]);
  expect(f.db.query("SELECT id FROM offline_operations").all()).toHaveLength(2);
});

it("syncs work on a downloaded version after the template is unpublished or discarded", async () => {
  const f = fixture();
  f.publish("template", 3, "unpublished");
  expect((await f.apply(formStart())).status).toBe(201);
  f.publish("template", 4, "discarded");
  expect((await f.apply(formStart())).status).toBe(201);
  // A global template unpublished after download.
  f.db
    .query(
      "INSERT INTO form_template_families (id, scope, organization_id, current_version, created_by, created_at, updated_at) VALUES ('global-template', 'global', NULL, 1, 'user-1', '2026-10-01', '2026-10-01')",
    )
    .run();
  f.db
    .query(
      "INSERT INTO form_template_versions (id, template_id, version, name, description, definition, status, created_by, created_at) VALUES ('global-template-1', 'global-template', 1, 'Global', '', ?, 'published', 'user-1', '2026-10-01')",
    )
    .run(JSON.stringify(definition));
  f.publish("global-template", 2, "unpublished");
  expect(
    (await f.apply({ ...formStart(), templateId: "global-template" })).status,
  ).toBe(201);
  // A version that was never published was never downloaded.
  expect((await f.apply({ ...formStart(), templateVersion: 2 })).status).toBe(
    409,
  );
});

it("rolls back receipts and domain writes if history fails, then retries successfully", async () => {
  const f = fixture();
  const start = formStart();
  expect((await f.apply(start)).status).toBe(201);
  const save = formSave(
    start.id,
    { check: { value: "pass", at: at(5), base: null } },
    { complete: true },
  );
  f.db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON activity_events WHEN NEW.action = 'form.completed' BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  expect((await f.apply(save)).status).toBe(500);
  expect(f.form(start.id)).toMatchObject({
    status: "in_progress",
    revision: 1,
  });
  expect(f.db.query("SELECT id FROM offline_operations").all()).toEqual([
    { id: start.id },
  ]);
  f.db.exec("DROP TRIGGER fail_history");
  expect((await f.apply(save)).status).toBe(201);
});

it("creates standalone issues and rejects former assignees", async () => {
  const f = fixture();
  const issue: OfflineOperation = {
    type: "issue",
    id: crypto.randomUUID(),
    title: "Broken gate",
    description: "",
    priority: "medium",
    assignedTo: "user-2",
  };
  expect((await f.apply(issue)).status).toBe(409);
  expect((await f.apply({ ...issue, assignedTo: null })).status).toBe(201);
  expect(f.db.query("SELECT target_type, target_id FROM issues").all()).toEqual(
    [{ target_type: "workspace", target_id: null }],
  );
});

it("keeps no receipt when the assignee leaves before the issue is written", async () => {
  const f = fixture();
  seedMember(f.db, {
    createdAt: "2026-10-01",
    organizationId: "org_user-1",
    userId: "user-2",
  });
  f.hooks.before(
    "INSERT INTO issues",
    () => f.db.exec("DELETE FROM member WHERE userId = 'user-2'"),
    { method: "batch" },
  );
  const issue: OfflineOperation = {
    type: "issue",
    id: crypto.randomUUID(),
    title: "Broken gate",
    description: "",
    priority: "medium",
    assignedTo: "user-2",
  };
  expect(await f.apply(issue)).toMatchObject({
    body: {
      error:
        "The issue assignee is no longer a member. Your local work has been kept.",
    },
    status: 409,
  });
  expect(f.db.query("SELECT id FROM offline_operations").all()).toEqual([]);
  expect(f.db.query("SELECT id FROM issues").all()).toEqual([]);
  expect((await f.apply({ ...issue, assignedTo: null })).status).toBe(201);
});

it("keeps device-reported form times separate from server history time", async () => {
  const f = fixture();
  const start = formStart();
  expect((await f.apply(start)).status).toBe(201);
  const save = formSave(
    start.id,
    { check: { value: "pass", at: at(5), base: null } },
    { complete: true },
  );
  expect((await f.apply(save)).status).toBe(201);
  const event = f.db
    .query(
      "SELECT details, occurred_at FROM activity_events WHERE action = 'form.offline_synced'",
    )
    .get() as { details: string; occurred_at: string };
  expect(JSON.parse(event.details)).toEqual({
    clientStartedAt: save.completion?.startedAt,
    clientCompletedAt: save.completion?.completedAt,
  });
  expect(event.occurred_at).not.toBe(save.completion?.completedAt);
  expect((await f.apply(save)).status).toBe(200);
  expect(
    f.db
      .query(
        "SELECT id FROM activity_events WHERE action = 'form.offline_synced'",
      )
      .all(),
  ).toHaveLength(1);
});

type Start = Extract<OfflineOperation, { type: "formStart" }>;
type Save = Extract<OfflineOperation, { type: "formSave" }>;

/** An answer as a conflict event records it. */
interface RecordedAnswer {
  answeredAt: string | null;
  answeredBy: { email: string; id: string; name: string } | null;
  /** Null for an answer that was cleared. */
  value: string | null;
}

/** The details of an `form.answer_conflict_resolved` event. */
interface ConflictDetails {
  discarded: RecordedAnswer;
  kept: RecordedAnswer | null;
  prompt: string;
  reason: string;
  responseType: string;
}

function formStart(answers: Start["answers"] = {}): Start {
  return {
    type: "formStart",
    id: crypto.randomUUID(),
    projectId: "audited",
    templateId: "template",
    templateVersion: 1,
    answers,
  };
}

/** A save of `answers`, completing the form when asked. */
function formSave(
  formId: string,
  answers: Save["answers"],
  { complete = false } = {},
): Save {
  return {
    type: "formSave",
    id: crypto.randomUUID(),
    formId,
    answers,
    ...(complete
      ? {
          completion: {
            startedAt: "2026-11-10T11:00:00.000Z",
            completedAt: "2026-11-10T12:30:00.000Z",
          },
        }
      : {}),
  };
}

function fixture() {
  const db = createTestDatabase();
  databases.push(db);
  for (const id of ["user-1", "user-2"])
    seedAccount(db, { createdAt: "2026-10-01", id });
  // The project forms are made for; no one is a member, so syncs list none.
  db.exec(
    "INSERT INTO projects (id, organization_id, name, created_at, updated_at) VALUES ('audited', 'org_user-1', 'Audited', '2026-10-01', '2026-10-01')",
  );
  db.exec(
    "INSERT INTO form_template_families (id, scope, organization_id, current_version, created_by, created_at, updated_at) VALUES ('template', 'organization', 'org_user-1', 2, 'user-1', '2026-10-01', '2026-10-01')",
  );
  // Version 1 was published and downloaded; version 2 is a draft.
  for (const version of [1, 2])
    db.query(
      "INSERT INTO form_template_versions (id, template_id, version, name, description, definition, status, created_by, created_at) VALUES (?, 'template', ?, ?, '', ?, ?, 'user-1', '2026-10-01')",
    ).run(
      `version-${version}`,
      version,
      version === 1 ? "Downloaded" : "New name",
      JSON.stringify(definition),
      version === 1 ? "published" : "draft",
    );
  const app = testApp({ "/": offline }, scope);
  const hooks = queryHooks();
  const request = requester(app, testBindings({ DB: toD1(db, hooks) }));
  return {
    db,
    hooks,
    request,
    apply: (operation: OfflineOperation, identity = scope) =>
      request("POST", "/operations", { ...identity, operation }),
    form: (id: string) =>
      db
        .query(
          "SELECT status, responses, answer_meta, revision FROM forms WHERE id = ?",
        )
        .get(id),
    /** Adds the organization's template `id`, with version 1 published. */
    addTemplate(id: string, sections: unknown[]) {
      db.query(
        "INSERT INTO form_template_families (id, scope, organization_id, current_version, created_by, created_at, updated_at) VALUES (?, 'organization', 'org_user-1', 1, 'user-1', '2026-10-01', '2026-10-01')",
      ).run(id);
      db.query(
        "INSERT INTO form_template_versions (id, template_id, version, name, description, definition, status, created_by, created_at) VALUES (?, ?, 1, ?, '', ?, 'published', 'user-1', '2026-10-01')",
      ).run(`${id}-1`, id, id, JSON.stringify({ version: 1, sections }));
    },
    /** Saves an answer as an online save by `by` at `when` would. */
    edit(id: string, itemId: string, value: string, when: string, by: string) {
      db.query(
        `UPDATE forms SET responses = json_set(responses, ?, ?),
           answer_meta = json_set(answer_meta, ?, json_object('at', ?, 'by', ?, 'v', ?)),
           revision = revision + 1, activity_actor_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        `$.${itemId}`,
        value,
        `$.${itemId}`,
        when,
        by,
        crypto.randomUUID(),
        by,
        when,
        id,
      );
    },
    /** Clears an answer as an online save by `by` at `when` would. */
    clear(id: string, itemId: string, when: string, by: string) {
      db.query(
        `UPDATE forms SET responses = json_remove(responses, ?),
           answer_meta = json_set(answer_meta, ?, json_object('at', ?, 'by', ?, 'v', ?)),
           revision = revision + 1, activity_actor_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        `$.${itemId}`,
        `$.${itemId}`,
        when,
        by,
        crypto.randomUUID(),
        by,
        when,
        id,
      );
    },
    /** The form's resolved answer conflicts, oldest first. */
    conflicts(id: string) {
      const rows = db
        .query(
          "SELECT subject_id, details FROM activity_events WHERE root_id = ? AND action = 'form.answer_conflict_resolved' ORDER BY id",
        )
        .all(id) as { details: string; subject_id: string }[];
      return rows.map(({ details, subject_id }) => {
        const recorded: ConflictDetails = JSON.parse(details);
        return { details: recorded, subject_id };
      });
    },
    /** Saves the template's next version (`version`, or the one after its current) with `status`. */
    publish(templateId: string, version: number, status: string) {
      const next =
        version ||
        (
          db
            .query(
              "SELECT current_version FROM form_template_families WHERE id = ?",
            )
            .get(templateId) as { current_version: number }
        ).current_version + 1;
      db.query(
        "INSERT INTO form_template_versions (id, template_id, version, name, description, definition, status, created_by, created_at) VALUES (?, ?, ?, 'Template', '', ?, ?, 'user-1', '2026-10-02')",
      ).run(
        `${templateId}-${next}`,
        templateId,
        next,
        JSON.stringify(definition),
        status,
      );
      db.query(
        "UPDATE form_template_families SET current_version = ? WHERE id = ?",
      ).run(next, templateId);
    },
    async sync(after?: string) {
      const query = new URLSearchParams({
        ...scope,
        ...(after ? { after } : {}),
      });
      const response = await request<Synced>("GET", `/sync?${query}`);
      expect(response.status).toBe(200);
      return response.body;
    },
  };
}
