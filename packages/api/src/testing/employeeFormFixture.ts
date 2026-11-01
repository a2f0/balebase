import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { Hono } from "hono";
import { handleCheckrWebhook } from "../employeeForms/checkrSync";
import { employeeForms } from "../employeeForms/employeeForms";
import {
  disclosureFingerprint,
  screeningDisclosures,
} from "../employeeForms/screeningDisclosures";
import type { Bindings } from "../types";
import { testBindings } from "./bindings";
import { queryHooks, toD1 } from "./d1";
import { createTestDatabase } from "./database";
import { seedAccount, seedMember } from "./seed";
import { testApp } from "./session";

export const orgId = "org_owner";
/** The owner's write key, which `app(..., { apiKey: true })` acts through. */
const apiKeyId = "owner-key";

interface CheckrCall {
  body: FormData | string | null;
  idempotencyKey: string | null;
  method: string;
  url: string;
}

/** Records Checkr API calls, by path, and answers them with respond. */
export function mockCheckr(
  respond: (call: CheckrCall) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  const mock = {
    calls: [] as CheckrCall[],
    respond,
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input, init) => {
    const call: CheckrCall = {
      body:
        init?.body instanceof FormData
          ? init.body
          : (init?.body?.toString() ?? null),
      idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      method: init?.method ?? "GET",
      url: String(input).replace("https://api.checkr-staging.com/v1", ""),
    };
    mock.calls.push(call);
    return mock.respond(call);
  }) as typeof fetch;
  return mock;
}

/** Checkr staging accepting a submission and completing its report. */
export function checkrResponses(call: CheckrCall) {
  if (call.method === "POST" && call.url === "/candidates") {
    return Response.json({ id: "candidate-1" });
  }
  if (call.url.endsWith("/documents")) {
    return Response.json({ id: "document-1" }, { status: 201 });
  }
  if (call.method === "POST" && call.url === "/reports") {
    return Response.json({ id: "report-1", result: null, status: "pending" });
  }
  if (call.url === "/reports/report-1") {
    return Response.json({
      id: "report-1",
      result: "clear",
      status: "complete",
    });
  }
  return Response.json({ error: "unexpected" }, { status: 500 });
}

export function configureCheckr(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  fixture.bindings.CHECKR_API_KEY = "staging-key";
  fixture.bindings.CHECKR_ENV = "staging";
  fixture.bindings.CHECKR_BACKGROUND_PACKAGE = "background_package";
}

/** A background check requested in San Jose, CA and awaiting the person. */
export async function requestedScreening(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  configureCheckr(fixture);
  const id = await createRequirement(
    fixture,
    "background_check",
    "Background check",
  );
  const requested = await fixture
    .app("owner", "owner")
    .request(
      `/${id}/checkr/request`,
      jsonPost({ city: "San Jose", state: "CA" }),
    );
  expect(requested.status).toBe(200);
  return id;
}

/** A background check whose report Checkr is preparing. */
export async function orderedScreening(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  reportId = "report-1",
) {
  configureCheckr(fixture);
  const id = await createRequirement(
    fixture,
    "background_check",
    "Background check",
  );
  fixture.database
    .query(`UPDATE employee_requirements
            SET checkr_candidate_id = ?, checkr_report_id = ?,
                checkr_report_status = 'pending', status = 'in_progress',
                checkr_requested_at = ?, checkr_work_state = 'CA'
            WHERE id = ?`)
    .run(
      reportId === "report-1" ? "candidate-1" : `candidate-${id}`,
      reportId,
      now(),
      id,
    );
  return id;
}

/** Mocked candidate Homer Simpson, whom Checkr staging always clears. */
export function homerSubmission() {
  return {
    acknowledgments: {
      disclosure: true,
      stateNotices: ["CA"],
      summaryOfRights: true,
    },
    candidate: {
      dob: "1983-02-10",
      driverLicenseNumber: "M2233344",
      driverLicenseState: "CA",
      firstName: "Homer",
      lastName: "Simpson",
      noMiddleName: true,
      phone: "",
      ssn: "110-11-1100",
      zipcode: "94088",
    },
    copyRequested: true,
    residenceState: "CA",
    signature: {
      authorize: true,
      electronicRecords: true,
      name: "Homer Simpson",
    },
  };
}

/**
 * Submits the form, answering the current request with Acme's current
 * disclosures unless the body names others.
 */
export async function submitScreening(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: string,
  body: unknown,
  user = "employee",
  role = "member",
) {
  const current = fixture.database
    .query("SELECT checkr_requested_at FROM employee_requirements WHERE id = ?")
    .get(id) as { checkr_requested_at: string | null } | null;
  return fixture.app(user, role).request(`/${id}/checkr/submit`, {
    body: JSON.stringify({
      disclosureFingerprint: await disclosureFingerprint(
        screeningDisclosures("Acme"),
      ),
      requestRevision: current?.checkr_requested_at,
      ...(body as object),
    }),
    headers: {
      "Content-Type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "Test browser",
    },
    method: "POST",
  });
}

export function withoutCheckrKey(bindings: Bindings): Bindings {
  const { CHECKR_API_KEY: _apiKey, ...configured } = bindings;
  return configured;
}

export async function checkrWebhook(
  bindings: Bindings,
  event: unknown,
  signingKey: string | null = "staging-key",
) {
  const body = JSON.stringify(event);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (signingKey) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    headers.set("X-Checkr-Signature", Buffer.from(digest).toString("hex"));
  }
  const app = new Hono<{ Bindings: Bindings }>();
  app.post("/webhook", handleCheckrWebhook);
  const background: Promise<unknown>[] = [];
  const executionContext = {
    passThroughOnException: () => undefined,
    props: {},
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  } as unknown as ExecutionContext;
  const response = await app.request(
    "/webhook",
    { body, headers, method: "POST" },
    bindings,
    executionContext,
  );
  await Promise.all(background);
  return response;
}

export async function createRequirement(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  kind: string,
  title: string,
) {
  const response = await fixture.app("owner", "owner").request(
    "/",
    jsonPost({
      memberId: "employee-member",
      requirements: [{ kind, title, dueDate: "2026-10-01" }],
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { ids: string[] }).ids[0] ?? "";
}

export function jsonPost(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  };
}

export async function createFixture(migrations: { before?: string } = {}) {
  const database = createTestDatabase(migrations);
  seedPeople(database);
  const files = new Map<string, File>();
  const emails: Array<{
    html: string;
    from: { name: string; email: string };
    subject: string;
    text: string;
    to: { email: string; name: string };
  }> = [];
  const storageState = { failPutAfterWrite: false, failDelete: false };
  const hooks = queryHooks();
  const bindings = testBindings({
    AUTH_EMAIL_FROM: "no-reply@balebase.test",
    CORS_ORIGIN: "https://app.balebase.test",
    DB: toD1(database, hooks),
    EMAIL: {
      send: async (message: (typeof emails)[number]) => {
        emails.push(message);
      },
    } as unknown as SendEmail,
    STORAGE: documentStorage(files, storageState),
  });
  return {
    app: (
      userId: string,
      role: string,
      via: { apiKey?: boolean; impersonatedBy?: string } = {},
    ) => employeeFormsClient(bindings, userId, role, via),
    bindings,
    /**
     * Runs `action` before the next write containing `sql`, alone or in a
     * batch; a batch's hooks run before its transaction, as a concurrent
     * request would.
     */
    beforeRun: (sql: string, action: () => void) => hooks.before(sql, action),
    database,
    emails,
    files,
    hooks,
    storageState,
  };
}

/** The owner's organization, an employee, and an invitee from elsewhere. */
function seedPeople(database: Database) {
  for (const id of ["owner", "employee", "invitee", "other"])
    seedAccount(database, {
      createdAt: now(),
      id,
      ...(id === "owner" ? { organizationName: "Acme" } : {}),
    });
  seedMember(database, {
    createdAt: now(),
    id: "employee-member",
    organizationId: orgId,
    userId: "employee",
  });
  seedMember(database, {
    createdAt: now(),
    id: "other-member",
    organizationId: "org_other",
    userId: "invitee",
  });
  database
    .query(`INSERT INTO invitation
    (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
    VALUES ('invite', ?, 'invitee@example.com', 'member', 'pending', ?, ?, 'owner')`)
    .run(orgId, "2026-10-01", now());
  database
    .query(
      `INSERT INTO organization_api_keys
       (id, organization_id, name, access, token_prefix, token_hash,
        created_by, created_at)
       VALUES (?, ?, 'Assistant', 'write', 'test', 'hash', 'owner', ?)`,
    )
    .run(apiKeyId, orgId, now());
}

function employeeFormsClient(
  bindings: ReturnType<typeof testBindings>,
  userId: string,
  role: string,
  via: { apiKey?: boolean; impersonatedBy?: string },
) {
  const app = testApp(
    {},
    {
      organizationId: orgId,
      organizationRole: role,
      session: { impersonatedBy: via.impersonatedBy ?? null },
      userId,
    },
  );
  app.use("*", async (context, next) => {
    if (via.apiKey) {
      context.set("apiKey", {
        access: "write",
        channel: "mcp",
        id: apiKeyId,
        organizationId: orgId,
      });
    }
    await next();
  });
  app.route("/", employeeForms);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
  };
}

/** An R2 bucket of uploaded documents that can fail a write or a delete. */
function documentStorage(
  files: Map<string, File>,
  state: { failDelete: boolean; failPutAfterWrite: boolean },
) {
  return {
    put: async (key: string, file: File | Uint8Array) => {
      files.set(
        key,
        file instanceof File
          ? file
          : new File([file], key, { type: "application/pdf" }),
      );
      if (state.failPutAfterWrite) {
        throw new Error("Upload interrupted.");
      }
    },
    delete: async (key: string) => {
      if (state.failDelete) throw new Error("Storage unavailable.");
      files.delete(key);
    },
    get: async (key: string) => {
      const file = files.get(key);
      return file
        ? {
            body: file.stream(),
            httpEtag: '"test-etag"',
            writeHttpMetadata: (headers: Headers) => {
              headers.set("content-type", file.type);
            },
          }
        : null;
    },
  } as unknown as R2Bucket;
}

export function now() {
  return "2026-09-24T12:00:00.000Z";
}
