import { expect, it, spyOn } from "bun:test";
import { purgeDeletedObjects } from "../library/deletedObjectCleanup";
import { fixture, now, post } from "../testing/maintenanceFixture";
import { purgeDeletedOrganizations } from "./organizationPurge";

it("purges only organizations past 30 days and honors a restore or renewed deletion before execution", async () => {
  const f = fixture();
  f.insertActor();
  const insert = f.database.query(`INSERT INTO organization
    (id, name, slug, createdAt, deletedAt) VALUES (?, ?, ?, '2026-01-01', ?)`);
  for (const [id, deletedAt] of [
    ["boundary", "2026-08-29T12:00:00.000Z"],
    ["timezone", "2026-08-29T08:00:00.000-04:00"],
    ["recent", "2026-08-29T12:00:00.001Z"],
    ["active", null],
    ["invalid", "not-a-date"],
    ["restored", "2026-08-01"],
    ["renewed", "2026-08-01"],
  ] as const)
    insert.run(id, id, id, deletedAt);
  f.beforeOrganizationPurge(() => {
    f.database.exec(
      "UPDATE organization SET deletedAt = NULL WHERE id = 'restored'",
    );
    f.database.exec(
      "UPDATE organization SET deletedAt = '2026-09-28' WHERE id = 'renewed'",
    );
  });
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 2,
    skipped: 2,
    failed: 0,
  });
  expect(
    f.database.query("SELECT id FROM organization ORDER BY id").all(),
  ).toEqual(
    ["active", "invalid", "recent", "renewed", "restored"].map((id) => ({
      id,
    })),
  );
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 0,
    skipped: 0,
    failed: 0,
  });
  expect(f.deletedKeys).toEqual([]);
});

it("bounds organization purges to 25 and makes progress across repeated runs", async () => {
  const f = fixture();
  f.insertActor();
  const insert = f.database.query(`INSERT INTO organization
    (id, name, slug, createdAt, deletedAt) VALUES (?, ?, ?, '2026-01-01', '2026-08-01')`);
  for (let i = 29; i >= 0; i--) {
    const id = `org-${String(i).padStart(2, "0")}`;
    insert.run(id, id, id);
  }
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 25,
    skipped: 0,
    failed: 0,
  });
  expect(
    f.database.query("SELECT id FROM organization ORDER BY id").all(),
  ).toEqual(Array.from({ length: 5 }, (_, i) => ({ id: `org-${i + 25}` })));
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 5,
    skipped: 0,
    failed: 0,
  });
  expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
    purged: 0,
    skipped: 0,
    failed: 0,
  });
});

it("queues a confirmed organization purge, cascades records, and retains every kind of file for retryable cleanup", async () => {
  const f = fixture();
  f.insertActor();
  f.insertUser("person");
  f.database.exec(`
    INSERT INTO organization (id, name, slug, createdAt, deletedAt)
      VALUES ('purge', 'Purge', 'purge', '2020-01-01', '2020-02-01'),
             ('keep', 'Keep', 'keep', '2020-01-01', NULL);
    INSERT INTO member (id, organizationId, userId, role, createdAt)
      VALUES ('member', 'purge', 'person', 'owner', '2020-01-01');
    INSERT INTO objects (id, organization_id, object_key, filename, content_type, size, created_at)
      VALUES ('library', 'purge', 'purge/library', 'file.pdf', 'application/pdf', 1, '2020-01-01'),
             ('keep', 'keep', 'keep/library', 'file.pdf', 'application/pdf', 1, '2020-01-01');
    INSERT INTO objects (id, organization_id, object_key, filename, content_type, size, created_at, kind)
      VALUES ('image', 'purge', 'purge/image', 'image.png', 'image/png', 1, '2020-01-01', 'audit_issue_image');
    INSERT INTO inbound_emails (id, organization_id, envelope_from, envelope_to, raw_object_key, raw_size, received_at)
      VALUES ('email', 'purge', 'from@example.com', 'to@example.com', 'purge/raw', 1, '2020-01-01'),
             ('keep-email', 'keep', 'from@example.com', 'to@example.com', 'keep/raw', 1, '2020-01-01');
    INSERT INTO inbound_email_attachments (id, email_id, object_key, filename, content_type, size, created_at)
      VALUES ('attachment', 'email', 'purge/attachment', 'a.txt', 'text/plain', 1, '2020-01-01');
    INSERT INTO contracts (id, organization_id, title, document_object_key, document_filename,
      document_size, document_sha256, document_page_count, final_object_key, created_at, updated_at)
      VALUES ('contract', 'purge', 'Contract', 'purge/contract', 'contract.pdf', 1, 'hash', 1,
        'purge/final', '2020-01-01', '2020-01-01');
    INSERT INTO contract_templates (id, organization_id, current_version, created_at, updated_at)
      VALUES ('template', 'purge', 1, '2020-01-01', '2020-01-01');
    INSERT INTO contract_template_versions (id, template_id, version, name, definition_json,
      document_object_key, document_filename, document_size, document_sha256, document_page_count, created_at)
      VALUES ('version', 'template', 1, 'Template', '{}', 'purge/template', 'template.pdf', 1, 'hash', 1, '2020-01-01');
    INSERT INTO employee_requirements (id, organization_id, target_email, kind, title, due_date,
      document_key, created_at, updated_at)
      VALUES ('requirement', 'purge', 'person@example.com', 'form', 'Form', '2020-01-01',
        'purge/form', '2020-01-01', '2020-01-01');
    INSERT INTO employee_screening_consents (id, organization_id, requirement_id, user_id, signature_name,
      signed_at, disclosure_version, state_notices, document_key, created_at)
      VALUES ('consent', 'purge', 'requirement', 'person', 'Person', '2020-01-01', '1', '[]',
        'purge/consent', '2020-01-01');
  `);
  const catalog = (await (await f.request("/jobs")).json()) as {
    jobs: unknown[];
  };
  expect(catalog.jobs).toContainEqual(
    expect.objectContaining({
      id: "purgeDeletedOrganizations",
      name: "Purge deleted organizations",
      manual: true,
      description: expect.stringContaining("30 days"),
      runSchedule: expect.stringContaining("17 minutes past the hour"),
    }),
  );
  expect(
    (await f.request("/jobs/purgeDeletedOrganizations/runs", post("wrong")))
      .status,
  ).toBe(400);
  const response = await f.request(
    "/jobs/purgeDeletedOrganizations/runs",
    post("purgeDeletedOrganizations"),
  );
  expect(response.status).toBe(202);
  const { run } = (await response.json()) as { run: { runId: string } };
  await f.deliver(run.runId);
  await f.deliver(run.runId);
  expect(
    await (await f.request(`/jobs/runs/${run.runId}`)).json(),
  ).toMatchObject({
    run: {
      status: "succeeded",
      jobId: "purgeDeletedOrganizations",
      requestedBy: "actor",
      attempts: 1,
      output: { purged: 1 },
    },
    logs: [
      { message: "Job queued." },
      { message: "Manual run requested." },
      { message: "Processing attempt started." },
      { message: "Job completed." },
    ],
  });
  expect(f.database.query("SELECT id FROM organization").all()).toEqual([
    { id: "keep" },
  ]);
  expect(
    f.database.query("SELECT id FROM user WHERE id = 'person'").all(),
  ).toEqual([{ id: "person" }]);
  expect(f.database.query("SELECT id FROM member").all()).toEqual([]);
  expect(f.database.query("SELECT id FROM inbound_emails").all()).toEqual([
    { id: "keep-email" },
  ]);
  expect(
    f.database.query("SELECT id FROM inbound_email_attachments").all(),
  ).toEqual([]);
  expect(f.database.query("SELECT id FROM contracts").all()).toEqual([]);
  expect(
    f.database.query("SELECT id FROM employee_requirements").all(),
  ).toEqual([]);
  const keys = [
    "attachment",
    "consent",
    "contract",
    "final",
    "form",
    "image",
    "library",
    "raw",
    "template",
  ].map((name) => `purge/${name}`);
  expect(
    f.database
      .query(
        "SELECT object_key, organization_id FROM deleted_object_cleanup ORDER BY object_key",
      )
      .all(),
  ).toEqual(
    keys.map((object_key) => ({ object_key, organization_id: "purge" })),
  );
  expect(f.deletedKeys).toEqual([]);
  expect(await purgeDeletedObjects(f.bindings)).toBe(0);
  const cutoffs = {
    deletedBefore: "9999-12-31",
    abandonedClaimedBefore: "9999-12-31",
  };
  const deletion = spyOn(f.bindings.STORAGE, "delete").mockRejectedValue(
    new Error("Storage unavailable"),
  );
  await expect(purgeDeletedObjects(f.bindings, cutoffs)).rejects.toThrow(
    "Storage unavailable",
  );
  deletion.mockRestore();
  expect(
    f.database
      .query("SELECT count(*) AS count FROM deleted_object_cleanup")
      .get(),
  ).toEqual({ count: 9 });
  expect(await purgeDeletedObjects(f.bindings, cutoffs)).toBe(9);
  expect(f.deletedKeys.sort()).toEqual(keys);
  expect(await purgeDeletedObjects(f.bindings, cutoffs)).toBe(0);
});

it("rolls back organization deletion and cleanup tombstones together on a cascade failure", async () => {
  const f = fixture();
  f.insertActor();
  f.database.exec(`
    INSERT INTO organization (id, name, slug, createdAt, deletedAt)
      VALUES ('purge', 'Purge', 'purge', '2020-01-01', '2020-02-01');
    INSERT INTO inbound_emails (id, organization_id, envelope_from, envelope_to, raw_object_key, raw_size, received_at)
      VALUES ('email', 'purge', 'from@example.com', 'to@example.com', 'purge/raw', 1, '2020-01-01');
    CREATE TRIGGER reject_email_delete BEFORE DELETE ON inbound_emails
      BEGIN SELECT RAISE(ABORT, 'Failed cascade'); END;
  `);
  const run = await f.requestRun("purgeDeletedOrganizations");
  await f.deliver(run.id);
  expect(await (await f.request(`/jobs/runs/${run.id}`)).json()).toMatchObject({
    run: {
      status: "failed",
      errorCode: "MAINTENANCE_FAILED",
      output: { purged: 0, skipped: 0, failed: 1 },
    },
  });
  expect(f.database.query("SELECT id FROM organization").all()).toEqual([
    { id: "purge" },
  ]);
  expect(f.database.query("SELECT id FROM inbound_emails").all()).toEqual([
    { id: "email" },
  ]);
  expect(
    f.database.query("SELECT * FROM deleted_object_cleanup").all(),
  ).toEqual([]);
  expect(f.deletedKeys).toEqual([]);
});

it("isolates failing organizations, retains partial counters, and rotates the batch", async () => {
  const f = fixture();
  f.insertActor();
  const insert = f.database.query(`INSERT INTO organization
    (id, name, slug, createdAt, deletedAt) VALUES (?, ?, ?, '2020-01-01', '2020-02-01')`);
  for (let i = 0; i < 30; i++) {
    const id = `org-${String(i).padStart(2, "0")}`;
    insert.run(id, id, id);
  }
  f.database.exec(`CREATE TRIGGER reject_selected_purges BEFORE DELETE ON organization
    WHEN OLD.id < 'org-24' BEGIN SELECT RAISE(ABORT, 'Failed cascade'); END;`);
  const log = spyOn(console, "log");
  try {
    for (const output of [
      { purged: 1, skipped: 0, failed: 24 },
      { purged: 5, skipped: 0, failed: 20 },
    ]) {
      const run = await f.requestRun("purgeDeletedOrganizations");
      await f.deliver(run.id);
      expect(
        await (await f.request(`/jobs/runs/${run.id}`)).json(),
      ).toMatchObject({
        run: { status: "failed", errorCode: "MAINTENANCE_FAILED", output },
      });
    }
    expect(
      f.database
        .query(
          "SELECT count(*) AS count FROM organization WHERE id >= 'org-24'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      f.database
        .query(
          "SELECT count(*) AS count FROM organization WHERE purgeAttemptedAt IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 24 });
    expect(log).toHaveBeenCalledWith({
      event: "organization_purged",
      organizationId: "org-24",
    });
    f.database.exec("DROP TRIGGER reject_selected_purges");
    expect(await purgeDeletedOrganizations(f.bindings, now)).toEqual({
      purged: 24,
      skipped: 0,
      failed: 0,
    });
  } finally {
    log.mockRestore();
  }
});
