import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessToken, nextVersionCode, uploadInternal } from "../googlePlay";

type Call = { method: string; url: string; init: RequestInit };
type Reply = { status?: number; body: unknown };

const path = "androidpublisher/v3/applications/com.balebase.staging.app";
const app = `https://androidpublisher.googleapis.com/${path}`;
const uploadApp = `https://androidpublisher.googleapis.com/upload/${path}`;
const directory = mkdtempSync(join(tmpdir(), "google-play-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => fetchSpy?.mockRestore());

let fetchSpy: ReturnType<typeof spyOn> | undefined;

/** Answer each request from `routes` by "METHOD url" and record every call. */
function mockFetch(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const reply = routes[`${method} ${url}`];
    if (!reply) throw new Error(`Unexpected request ${method} ${url}`);
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch);
  return calls;
}

test("the next version code exceeds every bundle and track release", async () => {
  const calls = mockFetch({
    [`POST ${app}/edits`]: { body: { id: "e1" } },
    [`GET ${app}/edits/e1/bundles`]: {
      body: { bundles: [{ versionCode: 3 }, { versionCode: 9 }] },
    },
    [`GET ${app}/edits/e1/tracks`]: {
      body: {
        tracks: [
          { track: "production" },
          { track: "internal", releases: [{ versionCodes: ["12"] }] },
        ],
      },
    },
    [`DELETE ${app}/edits/e1`]: { body: {} },
  });
  expect(await nextVersionCode("t", "com.balebase.staging.app")).toBe(13);
  expect(calls.map((call) => call.method).at(-1)).toBe("DELETE");
  for (const call of calls) {
    expect(new Headers(call.init.headers).get("Authorization")).toBe(
      "Bearer t",
    );
  }
});

test("a new app starts at version code 1", async () => {
  mockFetch({
    [`POST ${app}/edits`]: { body: { id: "e1" } },
    [`GET ${app}/edits/e1/bundles`]: { body: {} },
    [`GET ${app}/edits/e1/tracks`]: { body: { tracks: [{ track: "beta" }] } },
    [`DELETE ${app}/edits/e1`]: { body: {} },
  });
  expect(await nextVersionCode("t", "com.balebase.staging.app")).toBe(1);
});

test("an upload rolls the bundle out to internal testing and commits", async () => {
  const bundle = join(directory, "app.aab");
  writeFileSync(bundle, "bundle-bytes");
  const calls = mockFetch({
    [`POST ${app}/edits`]: { body: { id: "e2" } },
    [`POST ${uploadApp}/edits/e2/bundles?uploadType=media`]: {
      body: { versionCode: 4 },
    },
    [`PUT ${app}/edits/e2/tracks/internal`]: { body: {} },
    [`POST ${app}/edits/e2:commit`]: { body: {} },
  });
  expect(await uploadInternal("t", "com.balebase.staging.app", bundle)).toBe(4);
  const [, upload, track, commit] = calls;
  expect(new Headers(upload?.init.headers).get("Content-Type")).toBe(
    "application/octet-stream",
  );
  expect(Buffer.from(upload?.init.body as Uint8Array).toString()).toBe(
    "bundle-bytes",
  );
  expect(JSON.parse(String(track?.init.body))).toEqual({
    track: "internal",
    releases: [{ versionCodes: ["4"], status: "completed" }],
  });
  expect(commit?.url).toBe(`${app}/edits/e2:commit`);
});

test("a rejected track update stops before the edit is committed", async () => {
  const bundle = join(directory, "app.aab");
  writeFileSync(bundle, "bundle-bytes");
  const calls = mockFetch({
    [`POST ${app}/edits`]: { body: { id: "e3" } },
    [`POST ${uploadApp}/edits/e3/bundles?uploadType=media`]: {
      body: { versionCode: 5 },
    },
    [`PUT ${app}/edits/e3/tracks/internal`]: {
      status: 403,
      body: { error: { message: "The caller does not have permission" } },
    },
  });
  await expect(
    uploadInternal("t", "com.balebase.staging.app", bundle),
  ).rejects.toThrow(
    "PUT /androidpublisher/v3/applications/com.balebase.staging.app/edits/e3/tracks/internal failed (403): The caller does not have permission",
  );
  expect(calls.some((call) => call.url.endsWith(":commit"))).toBe(false);
});

test("Play's error message reaches the caller", async () => {
  mockFetch({
    [`POST ${app}/edits`]: {
      status: 404,
      body: { error: { message: "Package not found" } },
    },
  });
  await expect(
    nextVersionCode("t", "com.balebase.staging.app"),
  ).rejects.toThrow("failed (404): Package not found");
});

test("the access token request is a JWT signed by the service account", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const keyFile = join(directory, "service-account.json");
  writeFileSync(
    keyFile,
    JSON.stringify({
      client_email: "uploader@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  const calls = mockFetch({
    "POST https://oauth2.googleapis.com/token": {
      body: { access_token: "issued" },
    },
  });
  expect(await accessToken(keyFile)).toBe("issued");
  const form = new URLSearchParams(String(calls[0]?.init.body));
  expect(form.get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  const [header = "", claims = "", signature = ""] = (
    form.get("assertion") ?? ""
  ).split(".");
  expect(
    createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url")),
  ).toBe(true);
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject(
    {
      iss: "uploader@example.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
    },
  );

  mockFetch({
    "POST https://oauth2.googleapis.com/token": {
      status: 400,
      body: { error: "invalid_grant" },
    },
  });
  await expect(accessToken(keyFile)).rejects.toThrow(
    "Google token exchange failed (400).",
  );
});
