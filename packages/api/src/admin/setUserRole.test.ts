import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../testing/database";
import { seedUser } from "../testing/seed";

const script = join(
  import.meta.dir,
  "../../../../scripts/admin/setUserRole.sh",
);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

/**
 * A migrated database file and a `bunx` that runs wrangler's `--command` SQL
 * against it, failing as wrangler does when a statement aborts.
 */
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "set-user-role-"));
  directories.push(directory);
  const path = join(directory, "d1.sqlite");
  const seeded = createTestDatabase();
  seedUser(seeded, {
    email: "person@example.com",
    id: "person",
    role: "user",
  });
  writeFileSync(path, seeded.serialize());
  seeded.close();
  const bunx = join(directory, "bunx");
  writeFileSync(
    bunx,
    `#!${process.execPath}
import { Database } from "bun:sqlite";
const args = process.argv.slice(2);
const database = new Database(${JSON.stringify(path)});
database.exec("PRAGMA foreign_keys = ON");
try {
  // bun:sqlite ignores errors from all but the last of several statements,
  // so run each one; the test's own values never contain "; SELECT ".
  for (const statement of String(args[args.indexOf("--command") + 1]).split(/; (?=SELECT )/))
    database.run(statement);
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
const results = database.query('SELECT email, role FROM "user"').all();
console.log(JSON.stringify([{ results, success: true }]));
`,
  );
  chmodSync(bunx, 0o755);
  return {
    path,
    run(email: string, role: string) {
      const { HOME = directory, PATH = "" } = process.env;
      return Bun.spawnSync(["bash", script, email, role, "--local"], {
        env: {
          AUTH_OPERATOR_EMAIL: "ops@example.com",
          AUTH_OPERATOR_NAME: "Ops Person",
          // Version-manager shims for jq read the operator's own HOME.
          HOME,
          PATH: `${directory}:${PATH}`,
        },
      });
    },
    read<T>(sql: string) {
      const database = new Database(path, { readonly: true });
      try {
        return database.query(sql).all() as T[];
      } finally {
        database.close();
      }
    },
  };
}

const roleEvents = `SELECT user_id, action, previous_role, new_role, actor_kind,
  actor_user_id, actor_name, actor_email FROM user_role_events ORDER BY occurred_at, rowid`;

it("records each platform role change with the operator who made it", () => {
  const f = setup();
  const granted = f.run("person@example.com", "admin");
  expect(granted.stderr.toString()).toBe("");
  expect(granted.exitCode).toBe(0);
  expect(granted.stdout.toString()).toContain("has the admin role");
  // Setting the role it already has changes and records nothing.
  expect(f.run("person@example.com", "admin").exitCode).toBe(0);
  expect(f.run("person@example.com", "user").exitCode).toBe(0);
  expect(f.read(roleEvents)).toEqual([
    {
      user_id: "person",
      action: "role_set",
      previous_role: "user",
      new_role: "admin",
      actor_kind: "operator",
      actor_user_id: null,
      actor_name: "Ops Person",
      actor_email: "ops@example.com",
    },
    {
      user_id: "person",
      action: "role_set",
      previous_role: "admin",
      new_role: "user",
      actor_kind: "operator",
      actor_user_id: null,
      actor_name: "Ops Person",
      actor_email: "ops@example.com",
    },
  ]);
  expect(f.read("SELECT role FROM user WHERE id = 'person'")).toEqual([
    { role: "user" },
  ]);
});

it("changes nothing for an unknown email or a failed record", () => {
  const f = setup();
  const missing = f.run("nobody@example.com", "admin");
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString()).toContain("No user has that email.");

  const database = new Database(f.path);
  database.exec(
    "CREATE TRIGGER reject_role_event BEFORE INSERT ON user_role_events BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  database.close();
  const unrecorded = f.run("person@example.com", "admin");
  expect(unrecorded.exitCode).not.toBe(0);
  expect(unrecorded.stderr.toString()).toContain("history unavailable");
  expect(f.read(roleEvents)).toEqual([]);
  expect(f.read("SELECT role FROM user WHERE id = 'person'")).toEqual([
    { role: "user" },
  ]);
});

it("refuses an unnamed operator or an unknown role in the database too", () => {
  const database = createTestDatabase();
  seedUser(database, { email: "person@example.com", id: "person" });
  const change = database.query(
    `INSERT INTO operator_role_changes (email, role, operator_name, operator_email)
     VALUES ('person@example.com', ?, ?, '')`,
  );
  expect(() => change.run("admin", "  ")).toThrow(
    "The operator must be named.",
  );
  expect(() => change.run("owner", "Ops Person")).toThrow(
    "Role must be either user or admin.",
  );
  expect(database.query("SELECT * FROM user_role_events").all()).toEqual([]);
  expect(
    database.query("SELECT role FROM user WHERE id = 'person'").get(),
  ).toEqual({
    role: "user",
  });
});
