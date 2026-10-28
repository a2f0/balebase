import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../deploy/verifyDeployment.sh");
const roots: string[] = [];

// Logs each request and answers header requests with CORS for the origin the
// caller sent, unless MOCK_ORIGIN overrides it.
const curlStub = `#!/usr/bin/env bash
request="$*"
printf '%s\\n' "\${request//$'\\n'/ }" >> "$MOCK_LOG"
origin=""
dump=false
write_out=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --header) [[ "$2" == Origin:* ]] && origin="\${2#Origin: }"; shift ;;
    --dump-header) dump=true; shift ;;
    --write-out) write_out=true; shift ;;
  esac
  shift
done
if [[ "$dump" == true ]]; then
  printf 'HTTP/2 200\\r\\naccess-control-allow-origin: %s\\r\\naccess-control-allow-credentials: true\\r\\n\\r\\n' "\${MOCK_ORIGIN:-$origin}"
fi
if [[ "$write_out" == true ]]; then printf '\\n522'; fi
`;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function verify(env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "balebase-verify-deployment-"));
  roots.push(root);
  await writeFile(join(root, "curl"), curlStub);
  await chmod(join(root, "curl"), 0o700);
  const log = join(root, "requests.log");
  await writeFile(log, "");
  const { PATH: executablePath } = process.env;
  const child = Bun.spawn(["/bin/bash", script], {
    env: {
      ...process.env,
      PATH: `${root}:${executablePath}`,
      MOCK_LOG: log,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  const requests = (await readFile(log, "utf8")).trim().split("\n");
  return { code, stderr, requests };
}

const urls = (requests: string[]) =>
  requests.map((request) => request.split(" ").at(-1));

test("production checks its URLs, auth CORS, and the edge error response", async () => {
  const { code, requests } = await verify({ DEPLOY_TIER: "prod" });
  expect(code).toBe(0);
  expect(urls(requests)).toEqual([
    "https://api.balebase.com/health",
    "https://api.balebase.com/api/auth/get-session",
    "https://api.balebase.com/api/auth/get-session",
    "https://api.balebase.com/cdn-cgi/error/522",
    "https://app.balebase.com",
    "https://balebase.com",
    "https://balebase.com/privacy/",
    "https://balebase.com/terms/",
    "https://balebase.com/data-retention/",
  ]);
  expect(requests[2]).toContain("--request OPTIONS");
  for (const request of requests) {
    expect(request).toContain("--doh-url https://cloudflare-dns.com/dns-query");
  }
  for (const request of requests.slice(1, 4)) {
    expect(request).toContain("--header Origin: https://app.balebase.com");
  }
  // Retries would hide the edge error that the check expects.
  expect(requests[3]).not.toContain("--retry");
  expect(requests[3]).not.toContain("--fail");
});

test("staging checks its own hosts without the production edge rule", async () => {
  const { code, requests } = await verify({
    DEPLOY_TIER: "staging",
    VERIFY_DOH_URL: "",
  });
  expect(code).toBe(0);
  expect(urls(requests)).toEqual([
    "https://api-staging.balebase.com/health",
    "https://api-staging.balebase.com/api/auth/get-session",
    "https://api-staging.balebase.com/api/auth/get-session",
    "https://app-staging.balebase.com",
    "https://website-staging.balebase.com",
    "https://website-staging.balebase.com/privacy/",
    "https://website-staging.balebase.com/terms/",
    "https://website-staging.balebase.com/data-retention/",
  ]);
  expect(requests[1]).toContain(
    "--header Origin: https://app-staging.balebase.com",
  );
  expect(requests.join("\n")).not.toContain("--doh-url");
});

test("a response for another origin or an unknown tier fails", async () => {
  const wrongOrigin = await verify({ MOCK_ORIGIN: "https://example.com" });
  expect(wrongOrigin.code).not.toBe(0);
  expect(wrongOrigin.stderr).toContain("lacks credentialed app CORS headers");
  const unknown = await verify({ DEPLOY_TIER: "dev" });
  expect(unknown.code).not.toBe(0);
  expect(unknown.stderr).toContain("Unknown deployment tier: dev");
});
