import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { createTestDatabase } from "../src/testing/database";

const root = resolve(import.meta.dir, "../../..");
const scratch = resolve(root, "packages/api/.wrangler");
await mkdir(scratch, { recursive: true });
const dir = await mkdtemp(resolve(scratch, "smtp-test-"));
let worker: Miniflare | undefined;
const token = crypto.randomUUID();
const legal = crypto.randomUUID();
const accounts = crypto.randomUUID();
const other = crypto.randomUUID();
const alias = `inbox+${crypto.randomUUID()}@inbox.balebase.com`;
try {
  const main = resolve(import.meta.dir, "smtpIntegrationWorker.ts");
  const config = resolve(dir, "wrangler.json");
  await writeFile(
    config,
    JSON.stringify({
      name: "smtp-test",
      main,
      compatibility_date: "2026-08-17",
      compatibility_flags: ["nodejs_compat"],
      upload_source_maps: false,
    }),
  );
  execFileSync(
    process.execPath,
    [
      "x",
      "--bun",
      "--no-install",
      "wrangler",
      "deploy",
      "--config",
      config,
      "--dry-run",
      "--outdir",
      dir,
    ],
    { cwd: root, stdio: "pipe" },
  );
  let txtAnswer = "balebase-verification=fixture";
  worker = new Miniflare(
    convertV4MiniflareOptions({
      name: "smtp-test",
      compatibilityDate: "2026-08-17",
      compatibilityFlags: ["nodejs_compat"],
      modulesRoot: "/",
      modules: [
        {
          type: "ESModule",
          path: "/index.js",
          contents: await readFile(
            resolve(dir, "smtpIntegrationWorker.js"),
            "utf8",
          ),
        },
      ],
      outboundService: async (request: Request) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name");
        assert.ok(
          name === "_balebase-verification.base.example.org" ||
            name === "_balebase-verification.other.example.org",
        );
        if (!txtAnswer)
          return Response.json({
            Status: 2,
            Question: [{ name, type: 16 }],
          });
        return Response.json({
          Status: 0,
          Question: [{ name, type: 16 }],
          Answer: [
            {
              name,
              type: 16,
              TTL: 0,
              data: `"${txtAnswer}"`,
            },
          ],
        });
      },
      d1Databases: ["DB"],
      r2Buckets: ["STORAGE"],
      bindings: {
        SMTP_INGRESS_TOKEN: token,
        INBOUND_EMAIL_DOMAIN: "inbox.balebase.com",
      },
    }),
  );
  const db = await worker.getD1Database("DB");
  const migrated = createTestDatabase();
  const schema = migrated
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all();
  migrated.close();
  // Use the current application schema, including its real cleanup and commit triggers.
  for (const { sql } of schema) await db.prepare(sql).run();
  await db
    .prepare(
      "INSERT INTO organization(id,name,slug,createdAt) VALUES ('org','org','org',0),('other','other','other',0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO inbound_domains VALUES ('claim','org','base.example.org','fixture','now'),('other-claim','other','other.example.org','fixture','now')",
    )
    .run();
  for (const [id, org, address, forwarding] of [
    [
      legal,
      "org",
      "legal@base.example.org",
      alias.slice(6, alias.indexOf("@")),
    ],
    [accounts, "org", "accounts@base.example.org", crypto.randomUUID()],
    [other, "other", "legal@other.example.org", crypto.randomUUID()],
  ] as const)
    await db
      .prepare(
        "INSERT INTO inbound_mailboxes(id,organization_id,name,address,forwarding_id) VALUES (?,?,?,?,?)",
      )
      .bind(id, org, address, address, forwarding)
      .run();
  const workerUrl = await worker.ready;
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      resolve(dir, "key.pem"),
      "-out",
      resolve(dir, "cert.pem"),
    ],
    { stdio: "pipe" },
  );
  const suite = Bun.spawn(
    [
      process.argv[2] ?? "python3",
      resolve(root, "smtp/integration.py"),
      workerUrl.origin,
      dir,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        SMTP_TEST_TOKEN: token,
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  assert.equal(await suite.exited, 0);
  const invalid = await worker.dispatchFetch(
    new URL("/internal/inbound-smtp/deliver", workerUrl).href,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Inbound-Recipient": "legal@base.example.org",
        "X-Inbound-Mailbox": legal,
        "X-Inbound-Delivery": crypto.randomUUID(),
      },
      body:
        'Content-Type: multipart/mixed; boundary="p"\r\n\r\n' +
        "--p\r\n\r\npart\r\n".repeat(1200) +
        "--p--\r\n",
    },
  );
  assert.equal(invalid.status, 422);
  txtAnswer = "balebase-verification=another-organization";
  const ownershipChanged = await worker.dispatchFetch(
    new URL("/internal/inbound-smtp/recipient", workerUrl).href,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Inbound-Recipient": "legal@base.example.org",
      },
    },
  );
  assert.equal(ownershipChanged.status, 503);
  txtAnswer = "";
  const dnsOutage = await worker.dispatchFetch(
    new URL("/internal/inbound-smtp/recipient", workerUrl).href,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Inbound-Recipient": "legal@base.example.org",
      },
    },
  );
  assert.equal(dnsOutage.status, 503);
  const forwarded = await worker.dispatchFetch(
    new URL("/fixture/forward", workerUrl).href,
    {
      method: "POST",
      headers: { "X-Recipient": alias },
      body: "To: wrong@example.net\r\nSubject: Forwarded\r\n\r\nsecond route",
    },
  );
  assert.equal(forwarded.status, 204);
  const { results } = await db
    .prepare(
      "SELECT mailbox_id, envelope_to, envelope_from, subject, raw_object_key FROM inbound_emails",
    )
    .all<{
      mailbox_id: string;
      envelope_to: string;
      envelope_from: string;
      subject: string;
      raw_object_key: string;
    }>();
  assert.equal(results.length, 4);
  assert.ok(
    results.some(
      (row) => row.mailbox_id === other && row.subject === "other workspace",
    ),
  );
  const storage = await worker.getR2Bucket("STORAGE");
  for (const [id, address] of [
    [legal, "legal@base.example.org"],
    [accounts, "accounts@base.example.org"],
  ]) {
    const mail = results.find(
      (row) => row.mailbox_id === id && row.subject === "SMTP delivery",
    );
    assert.ok(mail);
    assert.equal(mail.envelope_to, address);
    assert.equal(mail.envelope_from, "");
    const raw = await (await storage.get(mail.raw_object_key))?.text();
    assert.match(
      raw ?? "",
      /^Received: from \[127\.0\.0\.1\] by localhost with ESMTPS;/,
    );
    assert.match(raw ?? "", /To: unrelated@example.net/);
  }
  assert.ok(
    results.find(
      (row) =>
        row.mailbox_id === legal &&
        row.envelope_to === alias &&
        row.subject === "Forwarded",
    ),
  );
  const attachments = await db
    .prepare("SELECT object_key FROM inbound_email_attachments")
    .all<{ object_key: string }>();
  assert.equal(attachments.results.length, 2);
  for (const file of attachments.results)
    assert.equal(
      await (await storage.get(file.object_key))?.text(),
      "attachment body",
    );
  // A reversible workspace deletion retains the queued binding. After
  // restoration the original delivery succeeds; purging the email leaves
  // its receipt in place, so replay cannot recreate the deleted message.
  const delivery = crypto.randomUUID();
  const deliveryOptions = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Inbound-Recipient": "legal@base.example.org",
      "X-Inbound-Mailbox": legal,
      "X-Inbound-Delivery": delivery,
    },
    body: "Subject: staged delivery\r\n\r\nretained",
  };
  const endpoint = new URL("/internal/inbound-smtp/deliver", workerUrl).href;
  await db
    .prepare("UPDATE organization SET deletedAt='2020-01-01' WHERE id='org'")
    .run();
  assert.equal(
    (await worker.dispatchFetch(endpoint, deliveryOptions)).status,
    503,
  );
  await db
    .prepare("UPDATE organization SET deletedAt=NULL WHERE id='org'")
    .run();
  assert.equal(
    (await worker.dispatchFetch(endpoint, deliveryOptions)).status,
    204,
  );
  const purged = await db
    .prepare("DELETE FROM inbound_emails WHERE subject='staged delivery'")
    .run();
  assert.equal(purged.meta.changes, 1);
  assert.equal(
    (await worker.dispatchFetch(endpoint, deliveryOptions)).status,
    204,
  );
  assert.equal(
    await db
      .prepare("SELECT id FROM inbound_emails WHERE subject='staged delivery'")
      .first(),
    null,
  );
  console.log(
    "Worker D1/R2 contained exactly one delivery per SMTP recipient and a forwarded message in the same Legal inbox.",
  );
} finally {
  await worker?.dispose();
  await rm(dir, { recursive: true, force: true });
}
