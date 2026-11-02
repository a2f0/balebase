import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";

it("backfills each connection's latest failed sync from its jobs", () => {
  // Legacy rows only; their organization and creator are not under test.
  const database = createTestDatabase({ before: "0088", foreignKeys: false });
  const connection = database.query(
    `INSERT INTO plaid_items (id, organization_id, plaid_item_id,
       access_token_ciphertext, access_token_iv, created_by, created_at, updated_at)
     VALUES (?, 'org', ?, 'ciphertext', 'iv', 'user', '2026-10-01', '2026-10-01')`,
  );
  for (const id of ["failing", "healthy", "untouched"]) connection.run(id, id);
  const job = database.query(
    `INSERT INTO job_runs (id, job_id, connection_id, organization_id, source,
       status, available_at, created_at, finished_at)
     VALUES (?, ?, ?, 'org', 'daily', ?, ?, ?, ?)`,
  );
  const runs: [string, string, string, string, string | null][] = [
    [
      "old-failure",
      "syncFinanceConnection",
      "failing",
      "failed",
      "2026-10-28T00:01:01.389Z",
    ],
    [
      "new-failure",
      "syncFinanceConnection",
      "failing",
      "failed",
      "2026-11-02T10:44:58.795Z",
    ],
    // Newer than every failure, but not failures.
    [
      "success",
      "syncFinanceConnection",
      "failing",
      "succeeded",
      "2026-11-03T00:00:00.000Z",
    ],
    [
      "cancelled",
      "syncFinanceConnection",
      "failing",
      "cancelled",
      "2026-11-04T00:00:00.000Z",
    ],
    ["running", "syncFinanceConnection", "failing", "running", null],
    ["other-job", "otherJob", "failing", "failed", "2026-11-05T00:00:00.000Z"],
    [
      "healthy-success",
      "syncFinanceConnection",
      "healthy",
      "succeeded",
      "2026-11-01T00:00:00.000Z",
    ],
  ];
  for (const [id, jobId, connectionId, status, finishedAt] of runs)
    job.run(
      id,
      jobId,
      connectionId,
      status,
      "2026-10-01",
      "2026-10-01",
      finishedAt,
    );

  applyMigrations(database, { from: "0088" });

  expect(
    database
      .query("SELECT id, last_failed_sync_at FROM plaid_items ORDER BY id")
      .all(),
  ).toEqual([
    { id: "failing", last_failed_sync_at: "2026-11-02T10:44:58.795Z" },
    { id: "healthy", last_failed_sync_at: null },
    { id: "untouched", last_failed_sync_at: null },
  ]);
});
