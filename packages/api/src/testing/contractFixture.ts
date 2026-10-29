import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import type { TemplateDefinition } from "@balebase/validators/contractTemplates";
import { Hono } from "hono";
import { degrees, PDFDocument } from "pdf-lib";
import { contracts } from "../contracts";
import { signing } from "../signing";
import { memoryStorage, testBindings } from "./bindings";
import { queryHooks, toD1 } from "./d1";
import { createTestDatabase } from "./database";
import { requester } from "./http";
import { seedOrganization, seedUser } from "./seed";
import { type ApiTestEnv, withTestSession } from "./session";

export const timestamp = "2026-09-20T12:00:00.000Z";

export interface SentEmail {
  attachments?: Array<{ filename: string; type: string }>;
  replyTo?: string;
  subject: string;
  text: string;
  to: { email: string; name: string };
}

export interface Contract {
  document: { pageCount: number; sha256: string };
  events: Array<{ recipientId: string | null; type: string }>;
  fields: Array<{ id: string; recipientId: string; type: string }>;
  finalSha256: string | null;
  id: string;
  recipients: Array<{
    email: string;
    id: string;
    name: string;
    status: string;
  }>;
  status: string;
}

export const signers = [
  { email: "sam@example.com", key: "sam", name: "Sam Signer", routingOrder: 1 },
  {
    email: "cai@example.com",
    key: "cai",
    name: "Cai Cosigner",
    routingOrder: 2,
  },
];

export function draft(overrides: Record<string, unknown> = {}) {
  return {
    dueDate: "2026-10-01",
    fields: [
      {
        height: 0.05,
        page: 1,
        recipientKey: "sam",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.8,
      },
      {
        height: 0.03,
        page: 1,
        recipientKey: "sam",
        type: "date_signed",
        width: 0.2,
        x: 0.5,
        y: 0.8,
      },
      {
        height: 0.03,
        label: "Title",
        page: 2,
        recipientKey: "sam",
        type: "text",
        width: 0.2,
        x: 0.1,
        y: 0.1,
      },
      {
        height: 0.05,
        page: 2,
        recipientKey: "cai",
        type: "signature",
        width: 0.3,
        x: 0.1,
        y: 0.8,
      },
      {
        height: 0.04,
        page: 2,
        recipientKey: "cai",
        type: "initials",
        width: 0.1,
        x: 0.6,
        y: 0.8,
      },
    ],
    message: "Please review before Friday.",
    recipients: signers,
    reminderIntervalDays: 2,
    signingOrder: "parallel",
    title: "Services agreement",
    ...overrides,
  };
}

export function createFixture() {
  const database = createTestDatabase();
  seed(database);
  const emails: SentEmail[] = [];
  const storage = {
    failWrites: false,
    loseNextResponse: false,
    queuedAtPut: [] as boolean[],
  };
  const { bucket, stored } = memoryStorage(new Map(), {
    afterPut: () => {
      if (!storage.loseNextResponse) return;
      storage.loseNextResponse = false;
      throw new Error("The storage response was lost.");
    },
    beforePut: (key) => {
      if (storage.failWrites) throw new Error("Storage is unavailable.");
      storage.queuedAtPut.push(
        database
          .query(
            `SELECT 1 FROM deleted_object_cleanup
             WHERE object_key = ? AND cleanup_token IS NULL`,
          )
          .get(key) !== null,
      );
    },
  });
  const hooks = queryHooks();
  const bindings = testBindings({
    DB: toD1(database, hooks),
    EMAIL: {
      send: async (message: SentEmail) => {
        emails.push(message);
        return { messageId: `message-${emails.length}` };
      },
    } as unknown as SendEmail,
    STORAGE: bucket,
  });

  const as = (userId: string, organizationId: string) =>
    contractClient(bindings, userId, organizationId);
  const owner = as("owner-user", "org-1");
  return {
    ...owner,
    as,
    bindings,
    database,
    emails,
    hooks,
    storage,
    prepare: async (body: ReturnType<typeof draft>) => {
      const created = await owner.upload(
        await samplePdf(),
        "Services agreement.pdf",
      );
      const saved = await owner.json(
        "PUT",
        `/api/contracts/${created.body.contract.id}/draft`,
        body,
      );
      if (saved.status !== 200)
        throw new Error(`Draft not saved: ${JSON.stringify(saved.body)}`);
      return created.body.contract.id;
    },
    stored,
  };
}

function contractClient(
  bindings: ReturnType<typeof testBindings>,
  userId: string,
  organizationId: string,
) {
  const session = withTestSession({
    organizationId,
    organizationRole: "member",
    userId,
  });
  // Signing links are public, so only the contract routes are signed in.
  const app = new Hono<ApiTestEnv>();
  app.use("/api/contracts/*", session);
  app.use("/api/contracts", session);
  app.route("/api/contracts", contracts);
  app.route("/api/signing", signing);
  const request = (path: string, init?: RequestInit) =>
    app.request(path, init, bindings);
  const send = requester(app, bindings);
  const json = <T = unknown>(method: string, path: string, body?: unknown) =>
    body === undefined || method === "GET"
      ? send<T>(method, path)
      : send<T>(method, path, body, { "cf-connecting-ip": "203.0.113.7" });
  const upload = (bytes: Uint8Array, filename: string) => {
    const form = new FormData();
    form.set("file", new File([bytes], filename));
    return send<{ contract: Contract }>("POST", "/api/contracts", form);
  };
  return { json, request, upload };
}

function seed(database: Database) {
  for (const [id, name, email] of [
    ["owner-user", "Olivia Owner", "owner@example.com"],
    ["other-user", "Oscar Other", "other@example.com"],
  ] as const)
    seedUser(database, { createdAt: timestamp, email, id, name });
  for (const [id, name] of [
    ["org-1", "Acme, Inc."],
    ["org-2", "Other Co"],
  ] as const)
    seedOrganization(database, { createdAt: timestamp, id, name });
}

export async function samplePdf() {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  document.addPage([612, 792]).setRotation(degrees(90));
  return document.save();
}

export interface Template {
  currentVersion: number;
  definition: TemplateDefinition;
  document: { pageCount: number; sha256: string };
  id: string;
  name: string;
  version: number;
}

export async function uploadTemplate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const form = new FormData();
  form.set("file", new File([await samplePdf()], "Employment agreement.pdf"));
  const response = await fixture.request("/api/contracts/templates", {
    body: form,
    method: "POST",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { template: Template }).template;
}

export function templateVersion(template: Template) {
  return {
    definition: {
      fields: draft().fields.map(({ recipientKey, ...field }) => ({
        ...field,
        roleKey: recipientKey,
      })),
      message: "Please review this agreement.",
      reminderIntervalDays: 3,
      roles: signers.map(({ key, routingOrder }) => ({
        key,
        label: key === "sam" ? "Employee" : "Company",
        routingOrder,
      })),
      signingOrder: "sequential",
    },
    description: "An agreement with fields already placed.",
    expectedCurrentVersion: template.currentVersion,
    name: "Employment agreement",
    sourceVersion: template.version,
  };
}

export function roleMapping(version: number) {
  return {
    recipients: signers.map(({ key, name, email }) => ({
      email,
      name,
      roleKey: key,
    })),
    title: "Sam's employment agreement",
    version,
  };
}
