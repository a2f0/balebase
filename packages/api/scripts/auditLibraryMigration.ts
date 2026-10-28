import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  seededStarterVersions,
  starterMigrationSql,
  starterSeedKey,
  starterTemplateSql,
  starterTemplates,
} from "../src/auditLibrary";

// Writes the next migration for every starter template version in
// packages/api/auditLibrary that no committed migration seeds yet.
const name = process.argv[2] ?? "";
if (!/^[a-z0-9_]+$/.test(name)) {
  console.error(
    "Usage: bun run --cwd packages/api audit-library:migration <snake_case_name>",
  );
  process.exit(1);
}

const directory = join(import.meta.dir, "../migrations");
const filenames = readdirSync(directory)
  .filter((filename) => filename.endsWith(".sql"))
  .sort();
const seeded = seededStarterVersions(
  filenames.map((filename) => ({
    filename,
    sql: readFileSync(join(directory, filename), "utf8"),
  })),
);

const pending = starterTemplates().filter((template) => {
  const existing = seeded.get(starterSeedKey(template));
  if (existing && existing.sql !== starterTemplateSql(template)) {
    console.error(
      `${starterSeedKey(template)} is already published by ${existing.filename} with other content. Raise the template's version and publishedAt in its data file.`,
    );
    process.exit(1);
  }
  return !existing;
});
if (pending.length === 0) {
  console.log("Every starter template version is already seeded.");
  process.exit(0);
}

const last = Number(filenames.at(-1)?.slice(0, 4) ?? 0);
const filename = `${String(last + 1).padStart(4, "0")}_${name}.sql`;
writeFileSync(join(directory, filename), starterMigrationSql(pending));
console.log(
  `Wrote migrations/${filename} for ${pending.map(starterSeedKey).join(", ")}.`,
);
