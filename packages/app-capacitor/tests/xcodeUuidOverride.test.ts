import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Project = {
  parseSync(): void;
  generateUuid(): string;
  getFirstProject(): { firstProject: { mainGroup: string } };
  addFile(path: string, group: string): { fileRef: string } | null;
  writeSync(): string;
  hasFile(path: string): unknown;
  pbxFileReferenceSection(): Record<string, unknown>;
};

type HashUuid = ((
  value: string,
  namespace: string,
  buffer: Uint8Array,
) => unknown) & { DNS: string };

const root = fileURLToPath(new URL("..", import.meta.url));
// Resolve through the real owner graph, including Bun's physical package paths.
const capacitorRequire = createRequire(
  realpathSync(join(root, "node_modules/@capacitor/cli/package.json")),
);
const xcode = capacitorRequire("xcode") as { project(path: string): Project };
const xcodeRequire = createRequire(
  realpathSync(capacitorRequire.resolve("xcode/package.json")),
);
const uuid = xcodeRequire("uuid") as { v5: HashUuid };

test("Capacitor's Xcode owner generates usable IDs and round-trips project edits", () => {
  const project = xcode.project(
    join(root, "ios/App/App.xcodeproj/project.pbxproj"),
  );
  project.parseSync();
  const ids = Array.from({ length: 100 }, () => project.generateUuid());
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => /^[A-F0-9]{24}$/.test(id))).toBe(true);

  const filename = "DependencySmoke.swift";
  const added = project.addFile(
    filename,
    project.getFirstProject().firstProject.mainGroup,
  );
  if (!added) throw new Error("Xcode did not add the fixture file.");
  const directory = mkdtempSync(join(tmpdir(), "balebase-xcode-"));
  try {
    const path = join(directory, "project.pbxproj");
    writeFileSync(path, project.writeSync());
    const parsed = xcode.project(path);
    parsed.parseSync();
    expect(parsed.hasFile(filename)).toBeTruthy();
    expect(parsed.pbxFileReferenceSection()[added.fileRef]).toBeDefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the owner's UUID rejects an undersized output buffer", () => {
  expect(() => uuid.v5("probe", uuid.v5.DNS, Buffer.alloc(1))).toThrow(
    RangeError,
  );
});
