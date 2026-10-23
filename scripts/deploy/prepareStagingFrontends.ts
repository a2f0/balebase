import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

interface Domain {
  hostname: string;
  service: string;
}
const frontends = [
  {
    package: "app-web",
    worker: "balebase-client",
    hostname: "app-staging.balebase.com",
  },
  {
    package: "website",
    worker: "balebase-website",
    hostname: "website-staging.balebase.com",
  },
];

export async function prepareStagingFrontends(root: string, domains: Domain[]) {
  const configs = await Promise.all(
    frontends.map(async (frontend) => {
      const name = `${frontend.worker}-staging`;
      const matches = domains.filter(
        (domain) => domain.hostname === frontend.hostname,
      );
      if (matches.length !== 1 || matches[0]?.service !== name) {
        throw new Error(
          `Staging domain must already belong to ${name}: ${frontend.hostname}`,
        );
      }
      const file = resolve(
        root,
        "packages",
        frontend.package,
        "wrangler.jsonc",
      );
      const parsed = ts.parseConfigFileTextToJson(
        file,
        await readFile(file, "utf8"),
      );
      if (parsed.error || !parsed.config)
        throw new Error(`Invalid JSONC: ${file}`);
      const config = parsed.config as Record<string, unknown> & {
        name?: unknown;
        assets?: unknown;
      };
      const allowed = new Set([
        "$schema",
        "name",
        "compatibility_date",
        "workers_dev",
        "preview_urls",
        "assets",
      ]);
      if (
        config.name !== frontend.worker ||
        Object.keys(config).some((key) => !allowed.has(key))
      ) {
        throw new Error(
          `Expected asset-only frontend config for ${frontend.worker}`,
        );
      }
      const assets = config.assets as { directory?: unknown } | undefined;
      if (assets?.directory !== "./dist")
        throw new Error(`Unexpected assets for ${frontend.worker}`);
      return { frontend, config: { ...config, name } };
    }),
  );
  for (const { frontend, config } of configs) {
    const file = resolve(
      root,
      "packages",
      frontend.package,
      "wrangler.staging.jsonc",
    );
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`Prepared ${config.name} for ${frontend.hostname}`);
  }
}

if (import.meta.main) {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } =
    process.env;
  if (!account || !token)
    throw new Error("Cloudflare credentials are required");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = (await response.json()) as {
    success?: boolean;
    result?: Domain[];
  };
  if (!response.ok || !body.success || !Array.isArray(body.result)) {
    throw new Error("Could not verify staging frontend domains");
  }
  await prepareStagingFrontends(resolve(import.meta.dir, "../.."), body.result);
}
