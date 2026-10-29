import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";

it("migrates active and completed bank jobs without losing checkpoints, retry budgets, or deletion ownership", async () => {
  const database = createTestDatabase({ before: "0073" });
  try {
    database.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('actor', 'Actor', 'actor@example.com', 1, '2026-10-01', '2026-10-01');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('org', 'Org', 'org', '2026-10-01');`);
    for (const status of [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]) {
      database
        .query(`INSERT INTO plaid_items
        (id, organization_id, plaid_item_id, access_token_ciphertext, access_token_iv, created_by, created_at, updated_at)
        VALUES (?, 'org', ?, 'ciphertext', 'iv', 'actor', '2026-10-01', '2026-10-01')`)
        .run(status, status);
      database
        .query(`INSERT INTO finance_sync_jobs
        (id, connection_id, organization_id, source, requested_by, status, initial_cursor, cursor,
         added, modified, removed, pages, failures, restarts, lease_until, available_at, error_code, created_at, finished_at)
        VALUES (?, ?, 'org', 'manual', 'actor', ?, 'start-cursor', 'page-cursor',
          12, 3, 2, 4, 2, 1, '2026-10-26T18:00:00Z', '2026-10-26T17:00:00Z', 'SYNC_ERROR',
          '2026-10-26T16:00:00Z', ?)`)
        .run(
          `job-${status}`,
          status,
          status,
          ["queued", "running"].includes(status)
            ? null
            : "2026-10-26T16:30:00Z",
        );
    }
    const previous = database
      .query("SELECT * FROM finance_sync_jobs ORDER BY id")
      .all();
    applyMigrations(database, { before: "0074", from: "0073" });
    const migrated = database.query("SELECT * FROM job_runs ORDER BY id").all();
    for (let i = 0; i < previous.length; i++) {
      expect(migrated[i]).toMatchObject(previous[i] as Record<string, unknown>);
      expect(migrated[i]).toMatchObject({
        job_id: "syncFinanceConnection",
        attempts: 0,
        started_at: null,
        output_json: JSON.stringify({
          added: 12,
          modified: 3,
          removed: 2,
          pages: 4,
          restarts: 1,
        }),
      });
    }
    expect(database.query("SELECT message FROM job_logs").all()).toHaveLength(
      5,
    );
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    database.exec("DELETE FROM plaid_items WHERE id = 'failed'");
    expect(
      database.query("SELECT id FROM job_runs WHERE id = 'job-failed'").get(),
    ).toBeNull();
    expect(
      database
        .query("SELECT id FROM job_logs WHERE run_id = 'job-failed'")
        .get(),
    ).toBeNull();
    database.exec("DELETE FROM organization WHERE id = 'org'");
    expect(database.query("SELECT id FROM job_runs").all()).toEqual([]);
    expect(database.query("SELECT id FROM job_logs").all()).toEqual([]);
  } finally {
    database.close();
  }
});
