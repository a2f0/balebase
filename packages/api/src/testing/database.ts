import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = join(import.meta.dir, "../../migrations");
const migrations = readdirSync(directory)
  .filter((filename) => filename.endsWith(".sql"))
  .sort()
  .map((filename) => ({
    filename,
    sql: readFileSync(join(directory, filename), "utf8"),
  }));
let migratedImage: Uint8Array | undefined;

export interface MigrationRange {
  /** First migration to apply, by filename or numeric prefix such as "0062". */
  from?: string;
  /** Stops before this migration, by filename or numeric prefix. */
  before?: string;
}

/**
 * An in-memory database with every migration applied in order, enforcing
 * foreign keys as D1 does. Migration tests can stop `before` a migration and
 * seed legacy rows before applying the rest with `applyMigrations`.
 *
 * Turn `foreignKeys` off only for a migration test whose legacy rows lack
 * their parents. SQLite then leaves references to a renamed table pointing
 * at the old name, which D1, migrating with foreign keys on, never does.
 */
export function createTestDatabase(
  options: { before?: string; foreignKeys?: boolean } = {},
) {
  const foreignKeys = options.foreignKeys !== false;
  if (options.before === undefined && foreignKeys) {
    migratedImage ??= migrate(empty(true), {}).serialize();
    const database = Database.deserialize(migratedImage);
    database.exec("PRAGMA foreign_keys = ON");
    return database;
  }
  return migrate(empty(foreignKeys), { before: options.before });
}

/** Applies migrations in order under the database's foreign key setting. */
export function applyMigrations(database: Database, range: MigrationRange) {
  migrate(database, range);
}

function empty(foreignKeys: boolean) {
  const database = new Database(":memory:");
  database.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  return database;
}

function migrate(
  database: Database,
  { from, before }: { from?: string | undefined; before?: string | undefined },
) {
  const start = from === undefined ? 0 : position(from);
  const end = before === undefined ? migrations.length : position(before);
  for (const migration of migrations.slice(start, end))
    database.exec(migration.sql);
  return database;
}

function position(name: string) {
  return migrations.indexOf(findMigration(name));
}

function findMigration(name: string) {
  const migration = migrations.find(
    ({ filename }) => filename === name || filename.startsWith(`${name}_`),
  );
  if (!migration) throw new Error(`No migration named ${name}.`);
  return migration;
}
