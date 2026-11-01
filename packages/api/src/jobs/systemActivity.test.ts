import { describe, expect, it } from "bun:test";
import { purgeDiscardedAuditForms } from "../audits/discardedTemplatePurge";
import { purgeExpiredFreeAuditRuns } from "../billing/billingRetention";
import { purgeTrashedEmails } from "../inbox/trashedEmailPurge";
import { purgeDeletedObjects } from "../library/deletedObjectCleanup";
import { purgeDeletedOrganizations } from "../organizations/organizationPurge";
import { findActivity } from "../shared/activity";
import {
  maintenanceActor,
  systemActivityStatement,
} from "../shared/systemActivity";
import { applyMigrations, createTestDatabase } from "../testing/database";
import { fixture, now, post } from "../testing/maintenanceFixture";
import { seedUser } from "../testing/seed";
import { purgeRequestedUsers } from "../users/userDeletion";
import { isScheduled, maintenanceJobs } from "./maintenance";

type Fixture = ReturnType<typeof fixture>;

interface EventRow {
  action: string;
  actor_email: string;
  actor_name: string;
  actor_source: string | null;
  actor_type: string;
  actor_user_id: string | null;
  causation_id: string | null;
  causation_type: string | null;
  details: string;
  organization_id: string | null;
  root_id: string;
  root_label: string;
  root_type: string;
  subject_id: string;
  subject_type: string;
}

function events(f: Fixture, action: string) {
  return (
    f.database
      .query(
        `SELECT action, organization_id, root_type, root_id, root_label,
                subject_type, subject_id, actor_type, actor_source,
                actor_user_id, actor_name, actor_email, causation_type,
                causation_id, details
         FROM activity_events WHERE action = ? ORDER BY id`,
      )
      .all(action) as EventRow[]
  ).map((row) => ({
    ...row,
    details: JSON.parse(row.details) as Record<string, unknown>,
  }));
}

function failHistory(f: Fixture) {
  f.database.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON activity_events
    BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`);
}

function insertOrganization(
  f: Fixture,
  id: string,
  deletedAt: string | null = null,
  deletedByUserId: string | null = null,
) {
  f.database
    .query(
      `INSERT INTO organization (id, name, slug, createdAt, deletedAt, deletedByUserId)
       VALUES (?, ?, ?, '2026-01-01', ?, ?)`,
    )
    .run(id, `${id} name`, id, deletedAt, deletedByUserId);
}

function systemActor(source: string) {
  return {
    actor_email: "",
    actor_name: "Balebase maintenance",
    actor_source: source,
    actor_type: "system",
    actor_user_id: null,
  };
}

describe("system actors", () => {
  it("requires a user for user events and a source, never a user, otherwise", () => {
    const f = fixture();
    f.insertActor();
    const insert = (columns: string, values: string) =>
      f.database.exec(`INSERT INTO activity_events (
        root_type, root_id, root_label, subject_type, subject_id, action,
        actor_name, actor_email, occurred_at, details, ${columns})
        VALUES ('x', 'x', 'x', 'x', 'x', 'x.y', 'n', '', '2026-01-01', '{}', ${values})`);
    // The previous Worker's inserts name no actor type: they stay user events.
    insert("actor_user_id", "'actor'");
    expect(
      f.database.query("SELECT actor_type FROM activity_events").get(),
    ).toEqual({ actor_type: "user" });
    expect(() => insert("actor_type", "'user'")).toThrow("CHECK");
    expect(() => insert("actor_type, actor_user_id", "'user', NULL")).toThrow(
      "CHECK",
    );
    expect(() =>
      insert(
        "actor_type, actor_user_id, actor_source",
        "'system', 'actor', 'job'",
      ),
    ).toThrow("CHECK");
    expect(() => insert("actor_type", "'system'")).toThrow("CHECK");
    expect(() => insert("actor_type, actor_source", "'robot', 'job'")).toThrow(
      "CHECK",
    );
    expect(() =>
      insert(
        "actor_type, actor_source, causation_type",
        "'system', 'job', 'job_run'",
      ),
    ).toThrow("CHECK");
  });

  it("records one system or provider event per cause and only when its condition holds", async () => {
    const f = fixture();
    const db = f.bindings.DB;
    const input = {
      action: "x.changed",
      details: { count: 1 },
      occurredAt: now.toISOString(),
      organizationId: null,
      root: { id: "r", label: "R", type: "x" },
      subject: { id: "s", type: "x" },
    };
    const actor = maintenanceActor("someJob", "run-1");
    await db.batch([
      systemActivityStatement(db, actor, input),
      systemActivityStatement(db, actor, input),
      systemActivityStatement(db, maintenanceActor("someJob", "run-2"), input),
      systemActivityStatement(db, maintenanceActor("someJob", "run-3"), input, {
        bindings: [0],
        sql: "? = 1",
      }),
      systemActivityStatement(
        db,
        {
          causation: { id: "evt_1", type: "stripe_event" },
          provider: "stripe",
          type: "provider",
        },
        input,
      ),
    ]);
    expect(
      events(f, "x.changed").map((row) => [
        row.actor_type,
        row.actor_source,
        row.actor_name,
        row.causation_id,
      ]),
    ).toEqual([
      ["system", "someJob", "Balebase maintenance", "run-1"],
      ["system", "someJob", "Balebase maintenance", "run-2"],
      ["provider", "stripe", "Stripe", "evt_1"],
    ]);
  });

  it("keeps existing events, their IDs, and API key attribution across the rebuild", () => {
    const database = createTestDatabase({ before: "0086" });
    seedUser(database, { createdAt: "2026-01-01", id: "person" });
    database.exec(`INSERT INTO activity_events (
        id, organization_id, root_type, root_id, root_label, subject_type,
        subject_id, action, actor_user_id, actor_name, actor_email,
        occurred_at, details, historical)
      VALUES (41, NULL, 'audit_template', 't', 'Form', 'audit_template', 't',
        'audit.template_created', 'person', 'Person', 'person@example.com',
        '2026-01-02', '{"version":1}', 1)`);
    // An event since removed keeps its ID used.
    database.exec(`INSERT INTO activity_events (
        id, root_type, root_id, root_label, subject_type, subject_id, action,
        actor_user_id, actor_name, actor_email, occurred_at, details)
      VALUES (50, 'x', 'x', 'x', 'x', 'x', 'x.removed', 'person', 'Person', '',
        '2026-01-02', '{}');
      DELETE FROM activity_events WHERE id = 50`);
    applyMigrations(database, { from: "0086" });
    expect(
      database
        .query(
          "SELECT id, actor_type, actor_user_id, actor_source, historical, details FROM activity_events WHERE id = 41",
        )
        .all(),
    ).toEqual([
      {
        actor_source: null,
        actor_type: "user",
        actor_user_id: "person",
        details: '{"version":1}',
        historical: 1,
        id: 41,
      },
    ]);
    database.exec(`INSERT INTO activity_events (
        root_type, root_id, root_label, subject_type, subject_id, action,
        actor_user_id, actor_name, actor_email, occurred_at, details)
      VALUES ('x', 'x', 'x', 'x', 'x', 'x.y', 'person', 'Person', '', '2026-01-03', '{}')`);
    expect(
      database.query("SELECT MAX(id) AS id FROM activity_events").get(),
    ).toEqual({ id: 51 });
    expect(
      database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'activity_events'",
        )
        .all(),
    ).toEqual([{ name: "activity_api_key_attribution" }]);
    database.close();
  });
});

describe("account and organization purges", () => {
  it("records who asked for each account deletion in a root-admin purge history", async () => {
    const f = fixture();
    f.insertActor();
    f.insertUser("target");
    f.insertUser("self");
    f.insertUser("legacy", "2026-08-01");
    f.insertUser("member", "2026-08-01");
    f.database.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('active', 'Active', 'active', '2026-01-01');
      INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', 'active', 'member', 'owner', '2026-01-01');
      INSERT INTO user_deletion_requests
        (user_id, requested_at, requested_by_user_id, requested_by_name, requested_by_email)
      VALUES ('self', '2026-08-01', 'self', 'self', 'self@example.com')`);
    const marked = await f.request(
      "/users/target/deletion",
      post("target@example.com"),
    );
    expect(marked.status).toBe(200);
    f.database.exec(
      "UPDATE user_deletion_requests SET requested_at = '2026-08-02' WHERE user_id = 'target'",
    );
    const run = await f.requestRun("purgeRequestedUsers");
    await f.deliver(run.id);
    expect(
      f.database
        .query("SELECT id FROM user WHERE id IN ('target', 'self', 'legacy')")
        .all(),
    ).toEqual([]);
    const purged = events(f, "user.purged");
    expect(purged).toEqual(
      ["legacy", "self", "target"].map((id) => ({
        ...systemActor("purgeRequestedUsers"),
        action: "user.purged",
        causation_id: run.id,
        causation_type: "job_run",
        details: expect.any(Object),
        organization_id: null,
        root_id: id,
        root_label: id,
        root_type: "user",
        subject_id: id,
        subject_type: "user",
      })),
    );
    expect(purged.map(({ details }) => details)).toEqual([
      {
        requestedAt: "2026-08-01",
        requestedBy: null,
        requestedByEmail: null,
        requestedByName: null,
        via: null,
      },
      {
        requestedAt: "2026-08-01",
        requestedBy: "self",
        requestedByEmail: null,
        requestedByName: null,
        via: "self",
      },
      {
        requestedAt: "2026-08-02",
        requestedBy: "actor",
        requestedByEmail: "actor@example.com",
        requestedByName: "Admin Actor",
        via: "root_admin",
      },
    ]);
    // Nothing identifies the purged people beyond their opaque IDs.
    expect(JSON.stringify(purged)).not.toContain("target@example.com");
    expect(JSON.stringify(purged)).not.toContain("self@example.com");
    // The record outlives job history.
    f.database.exec("DELETE FROM job_logs; DELETE FROM job_runs");
    const history = await f.request("/jobs/purges");
    expect(history.status).toBe(200);
    const page = (await history.json()) as {
      events: { actor: unknown; root: { id: string } }[];
    };
    expect(page.events.map(({ root }) => root.id)).toEqual([
      "target",
      "self",
      "legacy",
    ]);
    expect(page.events[0]?.actor).toEqual({
      apiKey: null,
      email: "",
      id: null,
      name: "Balebase maintenance",
      source: "purgeRequestedUsers",
      type: "system",
    });
  });

  it("records nothing for a blocked or canceled account and keeps it when history fails", async () => {
    const f = fixture();
    f.insertUser("canceled", "2026-08-01");
    f.insertUser("kept", "2026-08-01");
    f.beforeUserDelete(() => {
      f.database.exec(
        "DELETE FROM user_deletion_requests WHERE user_id = 'canceled'",
      );
    });
    f.database.exec(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('active', 'Active', 'active', '2026-01-01');
      INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', 'active', 'kept', 'owner', '2026-01-01')`);
    expect(await purgeRequestedUsers(f.bindings, "run-1", now)).toEqual({
      purged: 0,
      blocked: 2,
    });
    expect(events(f, "user.purged")).toEqual([]);

    const failing = fixture();
    failing.insertUser("eligible", "2026-08-01");
    failHistory(failing);
    await expect(
      purgeRequestedUsers(failing.bindings, "run-1", now),
    ).rejects.toThrow("history unavailable");
    expect(
      failing.database.query("SELECT id FROM user WHERE id = 'eligible'").get(),
    ).toEqual({ id: "eligible" });
  });

  it("only root admins read the purge history", async () => {
    for (const session of [fixture("user"), fixture("admin", "impersonator")]) {
      expect((await session.request("/jobs/purges")).status).toBe(403);
    }
    expect((await fixture().request("/jobs/purges?cursor=0")).status).toBe(400);
  });

  it("records an organization's purge with who deleted it, without its name", async () => {
    const f = fixture();
    f.insertActor();
    insertOrganization(f, "gone", "2026-08-01", "actor");
    insertOrganization(f, "legacy", "2026-08-01");
    insertOrganization(f, "restored", "2026-08-01");
    f.database.exec(`INSERT INTO activity_events (
        organization_id, root_type, root_id, root_label, subject_type,
        subject_id, action, actor_user_id, actor_name, actor_email,
        occurred_at, details)
      VALUES ('gone', 'organization', 'gone', 'gone name', 'organization',
        'gone', 'organization.deletion_requested', 'actor', 'Admin Actor',
        'actor@example.com', '2026-08-01', '{"via":"root_admin"}')`);
    f.beforeOrganizationPurge(() => {
      f.database.exec(
        "UPDATE organization SET deletedAt = NULL WHERE id = 'restored'",
      );
    });
    expect(await purgeDeletedOrganizations(f.bindings, "run-9", now)).toEqual({
      purged: 2,
      skipped: 1,
      failed: 0,
    });
    const purged = events(f, "organization.purged");
    expect(purged.map(({ root_id, details }) => [root_id, details])).toEqual([
      [
        "gone",
        {
          deletedAt: "2026-08-01",
          deletedBy: "actor",
          deletedByEmail: "actor@example.com",
          deletedByName: "Admin Actor",
          via: "root_admin",
        },
      ],
      [
        "legacy",
        {
          deletedAt: "2026-08-01",
          deletedBy: null,
          deletedByEmail: null,
          deletedByName: null,
          via: null,
        },
      ],
    ]);
    expect(purged[0]).toMatchObject({
      ...systemActor("purgeDeletedOrganizations"),
      causation_id: "run-9",
      organization_id: null,
      root_label: "gone",
    });
    expect(JSON.stringify(purged)).not.toContain("gone name");
    // The organization's own activity goes with it; the purge record stays.
    expect(
      f.database
        .query(
          "SELECT COUNT(*) AS count FROM activity_events WHERE organization_id = 'gone'",
        )
        .get(),
    ).toEqual({ count: 0 });

    const failing = fixture();
    insertOrganization(failing, "kept", "2026-08-01");
    failHistory(failing);
    await expect(
      purgeDeletedOrganizations(failing.bindings, "run-1", now),
    ).rejects.toThrow();
    expect(failing.database.query("SELECT id FROM organization").all()).toEqual(
      [{ id: "kept" }],
    );
  });
});

describe("Free-plan retention", () => {
  function retentionFixture() {
    const f = fixture();
    seedUser(f.database, { createdAt: "2026-01-01", id: "user-1" });
    for (const id of ["free", "other", "paid"]) insertOrganization(f, id);
    f.database.exec(`INSERT INTO organization_billing
      (organization_id, stripe_status, stripe_price_id, updated_at)
      VALUES ('paid', 'active', 'price_pro', '2026-01-01')`);
    const insert = f.database.query(`INSERT INTO audits
      (id, organization_id, template_name, definition, responses, status,
       started_by, created_at, updated_at)
      VALUES (?, ?, 'Example form', '{"version":1,"sections":[]}', '{}',
              'completed', 'user-1', ?, ?)`);
    const audit = (id: string, organizationId: string, at: string) =>
      insert.run(id, organizationId, at, at);
    const bindings = { ...f.bindings, STRIPE_PRO_PRICE_ID: "price_pro" };
    return { audit, bindings, f };
  }

  it("records one event per organization and batch with the number of runs removed", async () => {
    const { audit, bindings, f } = retentionFixture();
    for (let i = 0; i < 101; i++)
      audit(`free-${String(i).padStart(3, "0")}`, "free", "2026-06-01");
    audit("free-recent", "free", "2026-08-20");
    audit("other-old", "other", "2026-06-02");
    audit("paid-old", "paid", "2026-06-01");
    expect(
      await purgeExpiredFreeAuditRuns(bindings, "run-r", "2026-07-27"),
    ).toBe(102);
    const purged = events(f, "organization.audit_runs_purged");
    expect(
      purged.map(({ organization_id, details }) => [
        organization_id,
        (details as { count?: unknown }).count,
      ]),
    ).toEqual([
      ["free", 100],
      ["free", 1],
      ["other", 1],
    ]);
    expect(purged[0]).toMatchObject({
      ...systemActor("purgeExpiredFreeAuditRuns"),
      causation_id: "run-r",
      details: { completedBefore: "2026-07-27", count: 100, retentionDays: 30 },
      root_id: "free",
      root_label: "free name",
      root_type: "organization",
    });
    // Each organization reads only its own retention history.
    const feed = await findActivity(f.bindings.DB, "other");
    expect(feed?.events.map(({ action, actor }) => [action, actor])).toEqual([
      [
        "organization.audit_runs_purged",
        {
          apiKey: null,
          email: "",
          id: null,
          name: "Balebase maintenance",
          source: "purgeExpiredFreeAuditRuns",
          type: "system",
        },
      ],
    ]);
    expect(
      await purgeExpiredFreeAuditRuns(bindings, "run-s", "2026-07-27"),
    ).toBe(0);
    expect(events(f, "organization.audit_runs_purged")).toHaveLength(3);
  });

  it("keeps the runs when history fails", async () => {
    const { audit, bindings, f } = retentionFixture();
    audit("free-old", "free", "2026-06-01");
    failHistory(f);
    await expect(
      purgeExpiredFreeAuditRuns(bindings, "run-r", "2026-07-27"),
    ).rejects.toThrow("history unavailable");
    expect(f.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "free-old" },
    ]);
  });
});

describe("discarded global form purge", () => {
  function formFixture() {
    const f = fixture();
    seedUser(f.database, { createdAt: "2026-01-01", id: "root" });
    for (const id of ["a", "b"]) insertOrganization(f, id);
    const family = (id: string, versions: [string, string, string][]) => {
      f.database
        .query(
          `INSERT INTO audit_template_families
           (id, scope, organization_id, current_version, created_by, created_at, updated_at)
           VALUES (?, 'global', NULL, ?, 'root', '2026-01-01', '2026-01-01')`,
        )
        .run(id, versions.length);
      versions.forEach(([name, status, at], index) => {
        f.database
          .query(
            `INSERT INTO audit_template_versions
             (id, template_id, version, name, description, definition, status, created_by, created_at)
             VALUES (?, ?, ?, ?, '', '{"version":1,"sections":[]}', ?, 'root', ?)`,
          )
          .run(`${id}-v${index + 1}`, id, index + 1, name, status, at);
      });
    };
    family("purged", [
      ["Safety v1", "published", "2026-01-01"],
      ["Safety draft", "draft", "2026-02-01"],
      ["Safety draft", "discarded", "2026-09-01"],
    ]);
    family("kept", [["Kept", "published", "2026-01-01"]]);
    const project = (id: string, organizationId: string, form: string) => {
      f.database
        .query(
          `INSERT INTO projects (id, organization_id, name, created_at, updated_at)
           VALUES (?, ?, ?, '2026-01-01', '2026-01-01')`,
        )
        .run(id, organizationId, `${id} name`);
      f.database
        .query(
          `INSERT INTO project_audit_forms (project_id, organization_id, template_id, added_at)
           VALUES (?, ?, ?, '2026-01-01')`,
        )
        .run(id, organizationId, form);
    };
    project("p-a", "a", "purged");
    project("p-b", "b", "purged");
    project("p-kept", "a", "kept");
    return f;
  }

  it("records the removal on each project that had the form, by the job", async () => {
    const f = formFixture();
    const when = new Date("2026-10-30T12:00:00.000Z");
    expect(await purgeDiscardedAuditForms(f.bindings, "run-f", when)).toBe(1);
    const removed = events(f, "project.form_disabled");
    expect(
      removed.map(({ organization_id, root_id, root_label, details }) => [
        organization_id,
        root_id,
        root_label,
        details,
      ]),
    ).toEqual(
      ["a", "b"].map((organization) => [
        organization,
        `p-${organization}`,
        `p-${organization} name`,
        { reason: "form_purged", templateId: "purged", title: "Safety v1" },
      ]),
    );
    expect(removed[0]).toMatchObject({
      ...systemActor("purgeDiscardedAuditForms"),
      causation_id: "run-f",
      subject_id: "purged",
      subject_type: "audit_template",
    });
    expect(
      f.database.query("SELECT project_id FROM project_audit_forms").all(),
    ).toEqual([{ project_id: "p-kept" }]);
  });

  it("records nothing when a restore wins or history fails", async () => {
    const when = new Date("2026-10-30T12:00:00.000Z");
    const restored = formFixture();
    restored.database.exec(`INSERT INTO audit_template_versions
      (id, template_id, version, name, description, definition, status, created_by, created_at)
      VALUES ('purged-v4', 'purged', 4, 'Safety v1', '', '{}', 'published', 'root', '2026-10-01');
      UPDATE audit_template_families SET current_version = 4 WHERE id = 'purged'`);
    expect(
      await purgeDiscardedAuditForms(restored.bindings, "run-f", when),
    ).toBe(0);
    expect(events(restored, "project.form_disabled")).toEqual([]);

    const failing = formFixture();
    failHistory(failing);
    await expect(
      purgeDiscardedAuditForms(failing.bindings, "run-f", when),
    ).rejects.toThrow("history unavailable");
    expect(
      failing.database
        .query("SELECT COUNT(*) AS count FROM project_audit_forms")
        .get(),
    ).toEqual({ count: 3 });
  });
});

describe("trashed email purge", () => {
  function emailFixture() {
    const f = fixture();
    insertOrganization(f, "a");
    const email = (id: string, deletedAt: string | null) =>
      f.database
        .query(
          `INSERT INTO inbound_emails
           (id, organization_id, envelope_from, envelope_to, subject,
            raw_object_key, raw_size, received_at, deleted_at)
           VALUES (?, 'a', 'sender@example.com', 'inbox@example.com', ?, ?, 1,
                   '2026-07-01', ?)`,
        )
        .run(id, `Subject ${id}`, `raw/${id}.eml`, deletedAt);
    email("old", "2026-08-01");
    email("recent", new Date().toISOString());
    email("restored", null);
    f.database.exec(`INSERT INTO inbound_email_attachments
        (id, email_id, object_key, filename, content_type, size, created_at)
      VALUES ('attachment', 'old', 'attachments/old.pdf', 'old.pdf',
              'application/pdf', 1, '2026-07-01');
      INSERT INTO library_folders (id, organization_id, name, created_at, updated_at)
      VALUES ('folder', 'a', 'Receipts', '2026-01-01', '2026-01-01');
      INSERT INTO inbound_email_links
        (id, organization_id, email_id, target_type, target_id, created_at)
      VALUES ('link', 'a', 'old', 'library_folder', 'folder', '2026-07-01')`);
    return f;
  }

  it("records each purge and the links it removes, then removes the bytes after commit", async () => {
    const f = emailFixture();
    f.insertActor();
    const run = await f.requestRun("purgeTrashedEmails");
    await f.deliver(run.id);
    expect(
      f.database.query("SELECT id FROM inbound_emails ORDER BY id").all(),
    ).toEqual([{ id: "recent" }, { id: "restored" }]);
    expect(events(f, "inbox.email_purged")).toEqual([
      {
        ...systemActor("purgeTrashedEmails"),
        action: "inbox.email_purged",
        causation_id: run.id,
        causation_type: "job_run",
        details: {
          attachmentCount: 1,
          deletedAt: "2026-08-01",
          equipmentLinkCount: 0,
          folderLinkCount: 1,
        },
        organization_id: "a",
        root_id: "old",
        root_label: "Subject old",
        root_type: "inbound_email",
        subject_id: "old",
        subject_type: "inbound_email",
      },
    ]);
    expect(events(f, "inbox.email_unlinked")).toMatchObject([
      {
        ...systemActor("purgeTrashedEmails"),
        details: {
          from: "sender@example.com",
          via: "email_purged",
          subject: "Subject old",
        },
        root_id: "folder",
        root_label: "Receipts",
        root_type: "library_folder",
        subject_id: "old",
      },
    ]);
    expect(f.deletedKeys).toEqual([]);
    await purgeDeletedObjects(f.bindings, {
      abandonedClaimedBefore: "2100-01-01",
      deletedBefore: "2100-01-01",
    });
    expect(f.deletedKeys.sort()).toEqual([
      "attachments/old.pdf",
      "raw/old.eml",
    ]);
  });

  it("runs only on request and keeps the email when a restore wins or history fails", async () => {
    const job = maintenanceJobs.find(({ id }) => id === "purgeTrashedEmails");
    expect(job && isScheduled(job)).toBe(false);
    const f = emailFixture();
    f.database.exec(
      "UPDATE inbound_emails SET deleted_at = NULL WHERE id = 'old'",
    );
    expect(await purgeTrashedEmails(f.bindings, "run-e", now)).toBe(0);

    const failing = emailFixture();
    failHistory(failing);
    await expect(
      purgeTrashedEmails(failing.bindings, "run-e", now),
    ).rejects.toThrow("history unavailable");
    expect(
      failing.database
        .query("SELECT COUNT(*) AS count FROM deleted_object_cleanup")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      failing.database
        .query("SELECT id FROM inbound_emails WHERE id = 'old'")
        .get(),
    ).toEqual({ id: "old" });
  });
});
