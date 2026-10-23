import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

test("compiled Worker errors retain bundle positions and finish their reports", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const parent = resolve(root, "packages/api/.wrangler");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "diagnostics-test-"));
  const events: string[] = [];
  let worker: Miniflare | undefined;
  try {
    await writeFile(
      resolve(directory, "wrangler.json"),
      JSON.stringify({
        name: "diagnostics-test",
        main: "index.ts",
        upload_source_maps: false,
        compatibility_date: "2026-08-17",
        compatibility_flags: ["nodejs_compat"],
      }),
    );
    await writeFile(
      resolve(directory, "index.ts"),
      `
      import { captureServerError } from ${JSON.stringify(resolve(root, "packages/diagnostics/src/server.ts"))};
      const build = { dsn: "https://${"a".repeat(32)}@o1.ingest.us.sentry.io/1", target: "api", environment: "staging", release: "balebase-api@${"b".repeat(40)}" };
      export default { async fetch() {
        const error = new TypeError("private customer content");
        await captureServerError(build, error, "request-error");
        return new Response("preserved response", { status: 500 });
      } };
    `,
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
        resolve(directory, "wrangler.json"),
        "--dry-run",
        "--upload-source-maps",
        "--outdir",
        resolve(directory, "build"),
      ],
      {
        cwd: root,
        stdio: "pipe",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    const contents = await readFile(
      resolve(directory, "build/index.js"),
      "utf8",
    );
    const map = JSON.parse(
      await readFile(resolve(directory, "build/index.js.map"), "utf8"),
    ) as { sources: string[] };
    expect(map.sources.some((source) => source.endsWith("index.ts"))).toBe(
      true,
    );
    worker = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: "2026-08-17",
        compatibilityFlags: ["nodejs_compat"],
        modulesRoot: "/",
        modules: [{ type: "ESModule", path: "/index.js", contents }],
        outboundService: async (request: Request) => {
          events.push(await request.text());
          return new Response("{}", { status: 200 });
        },
      }),
    );
    const response = await (await worker.getWorker()).fetch(
      "https://example.com/private",
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("preserved response");
    expect(events).toHaveLength(1);
    expect(events[0]).not.toContain("private");
    expect(events[0]).toContain('"filename":"app:///index.js"');
  } finally {
    await worker?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
