import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const domImport =
  /^import [^;]* from "(?:happy-dom|(?:\.\.?\/)+testing\/dom)";$/m;

test("exactly the .dom. test files mount in happy-dom", () => {
  const misnamed = readdirSync(import.meta.dir, {
    encoding: "utf8",
    recursive: true,
  })
    .filter((file) => /\.test\.tsx?$/.test(file))
    .filter(
      (file) =>
        file.includes(".dom.test.") !==
        domImport.test(readFileSync(join(import.meta.dir, file), "utf8")),
    );
  expect(misnamed).toEqual([]);
});
