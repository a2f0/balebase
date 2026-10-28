import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseTier } from "@balebase/diagnostics/config";
import { build } from "vite";
import { appUrl, noindex, searchIndexing } from "./vite.config";

const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))),
);

const aasa = `/.well-known/apple-app-site-association
  Content-Type: application/json
`;

async function buildShell(tier: ReleaseTier) {
  const root = await mkdtemp(join(tmpdir(), "balebase-search-indexing-"));
  roots.push(root);
  await mkdir(join(root, "public"));
  await writeFile(join(root, "public/_headers"), aasa);
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><html><head><title>Shell</title></head><body></body></html>",
  );
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [searchIndexing(tier)],
  });
  const read = (file: string) => readFile(join(root, "dist", file), "utf8");
  return { html: await read("index.html"), headers: await read("_headers") };
}

test("production names the app root canonical and noindexes only signing links", async () => {
  const { html, headers } = await buildShell("production");
  expect(html).toContain(`<link rel="canonical" href="${appUrl}">`);
  expect(html).toContain(`<meta property="og:url" content="${appUrl}">`);
  expect(html).not.toContain("noindex");
  expect(headers).toBe(`${aasa}\n/sign/*\n  X-Robots-Tag: ${noindex}\n`);
});

test("staging marks the shell and every response noindex, with no canonical", async () => {
  const { html, headers } = await buildShell("staging");
  expect(html).toContain(`<meta name="robots" content="${noindex}">`);
  expect(html).not.toContain("canonical");
  expect(html).not.toContain("og:url");
  // The existing rules stay, followed by a rule for every path.
  expect(headers).toBe(`${aasa}\n/*\n  X-Robots-Tag: ${noindex}\n`);
});
