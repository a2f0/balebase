import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toD1 } from "./d1";

describe("test D1", () => {
  it("counts rows that triggers write, as D1 does", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE uploads (id TEXT);
      CREATE TABLE pending (id TEXT);
      INSERT INTO pending VALUES ('a');
      CREATE TRIGGER claim AFTER INSERT ON uploads
      BEGIN DELETE FROM pending WHERE id = NEW.id; END;
    `);
    const db = toD1(database);
    const claimed = await db.prepare("INSERT INTO uploads VALUES ('a')").run();
    const [plain, guarded] = await db.batch([
      db.prepare("INSERT INTO uploads VALUES ('b')"),
      db.prepare("DELETE FROM pending WHERE id = 'missing'"),
    ]);
    const read = await db.prepare("SELECT * FROM uploads").run();

    expect(claimed.meta.changes).toBe(2);
    expect(plain?.meta.changes).toBe(1);
    expect(guarded?.meta.changes).toBe(0);
    expect(read.meta.changes).toBe(0);
  });

  it("leaves no API write that expects exactly one changed row", () => {
    const source = join(import.meta.dir, "..");
    const exact = /meta\.changes\)?\s*[!=]==\s*1\b/;
    const found = readdirSync(source)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .flatMap((name) =>
        readFileSync(join(source, name), "utf8")
          .split("\n")
          .flatMap((line, index) =>
            exact.test(line) ? [`${name}:${index + 1}`] : [],
          ),
      );

    expect(found).toEqual([]);
  });
});
