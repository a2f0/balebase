import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

/*
 * Minimal Google Play Developer API client for scripts/releaseAndroid.sh:
 *   googlePlay.ts next-version-code <service-account.json> <package>
 *   googlePlay.ts upload-internal <service-account.json> <package> <bundle.aab>
 */

const api = "https://androidpublisher.googleapis.com";
const usage =
  "Usage: googlePlay.ts next-version-code|upload-internal <service-account.json> <package> [bundle.aab]";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface Track {
  track: string;
  releases?: { versionCodes?: string[] }[];
}

const base64Url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

async function accessToken(keyFile: string) {
  const key = JSON.parse(await readFile(keyFile, "utf8")) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    { alg: "RS256", typ: "JWT" },
    {
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
  ]
    .map((part) => base64Url(JSON.stringify(part)))
    .join(".");
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(key.private_key);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(signature)}`,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error(`Google token exchange failed (${response.status}).`);
  }
  return body.access_token;
}

async function play<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed (${response.status}): ${body.error?.message ?? "no message"}`,
    );
  }
  return body;
}

async function openEdit(token: string, app: string) {
  const { id } = await play<{ id: string }>(token, `${app}/edits`, {
    method: "POST",
  });
  return `${app}/edits/${id}`;
}

async function nextVersionCode(token: string, app: string) {
  const edit = await openEdit(token, app);
  // Play rejects any version code it has seen, including bundles left
  // outside a track, so take the largest across bundles and track releases.
  const [{ bundles = [] }, { tracks = [] }] = await Promise.all([
    play<{ bundles?: { versionCode: number }[] }>(token, `${edit}/bundles`),
    play<{ tracks?: Track[] }>(token, `${edit}/tracks`),
  ]);
  await play(token, edit, { method: "DELETE" });
  const codes = [
    ...bundles.map((bundle) => bundle.versionCode),
    ...tracks.flatMap((track) =>
      (track.releases ?? []).flatMap((release) =>
        (release.versionCodes ?? []).map(Number),
      ),
    ),
  ];
  return Math.max(0, ...codes) + 1;
}

async function uploadInternal(token: string, app: string, bundlePath: string) {
  const edit = await openEdit(token, app);
  const { versionCode } = await play<{ versionCode: number }>(
    token,
    `/upload${edit}/bundles?uploadType=media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: await readFile(bundlePath),
    },
  );
  await play(token, `${edit}/tracks/internal`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      track: "internal",
      releases: [{ versionCodes: [String(versionCode)], status: "completed" }],
    }),
  });
  await play(token, `${edit}:commit`, { method: "POST" });
  return versionCode;
}

const [command, keyFile, packageName, bundlePath] = process.argv.slice(2);
if (!keyFile || !packageName) throw new Error(usage);
const app = `/androidpublisher/v3/applications/${packageName}`;
if (command === "next-version-code") {
  console.log(await nextVersionCode(await accessToken(keyFile), app));
} else if (command === "upload-internal" && bundlePath) {
  const versionCode = await uploadInternal(
    await accessToken(keyFile),
    app,
    bundlePath,
  );
  console.log(`Uploaded ${packageName} ${versionCode} to internal testing.`);
} else {
  throw new Error(usage);
}
