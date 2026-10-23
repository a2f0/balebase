import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, resolveConfig } from "vite";
import { sentryAssets } from "../vite";

test("release builds emit matching chunk manifests and hidden maps; dev stays disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balebase-sentry-vite-"));
  const previous = Reflect.get(process.env, "SENTRY_BUILD_CONFIG");
  const config = {
    dsn: `https://${"a".repeat(32)}@o1.ingest.us.sentry.io/1`,
    target: "web",
    environment: "staging",
    release: `balebase-web@${"b".repeat(40)}`,
  };
  Object.assign(process.env, { SENTRY_BUILD_CONFIG: JSON.stringify(config) });
  try {
    const development = await resolveConfig(
      { configFile: false, plugins: [sentryAssets()] },
      "serve",
    );
    expect(Reflect.get(development.define ?? {}, "__SENTRY_BUILD__")).toBe(
      "undefined",
    );
    await writeFile(
      join(directory, "index.html"),
      '<script type="module" src="/index.js"></script>',
    );
    await writeFile(join(directory, "index.js"), 'console.log("application");');
    const result = await build({
      root: directory,
      configFile: false,
      plugins: [sentryAssets()],
      build: { write: false },
      logLevel: "silent",
    });
    const output = Array.isArray(result)
      ? result[0]?.output
      : "output" in result
        ? result.output
        : undefined;
    const manifest = output?.find(
      (file) => file.fileName === "sentry-assets.json",
    );
    if (manifest?.type !== "asset") throw new Error("Missing manifest");
    const parsed = JSON.parse(String(manifest.source)) as {
      paths: string[];
      release: string;
    };
    expect(parsed.release).toBe(config.release);
    const chunks = output?.filter((file) => file.type === "chunk") ?? [];
    expect(parsed.paths).toEqual(chunks.map((chunk) => `/${chunk.fileName}`));
    for (const chunk of chunks) {
      expect(chunk.code).not.toContain("sourceMappingURL");
      expect(
        output?.some((file) => file.fileName === `${chunk.fileName}.map`),
      ).toBe(true);
    }
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(process.env, "SENTRY_BUILD_CONFIG");
    else Reflect.set(process.env, "SENTRY_BUILD_CONFIG", previous);
    await rm(directory, { recursive: true, force: true });
  }
});
