import type { AuditDefinition } from "@balebase/validators/audits";
import { activity } from "../activity";
import { adminAuditTemplates } from "../adminAuditTemplates";
import { audits } from "../audits";
import { offline } from "../offline";
import { memoryStorage, testBindings } from "./bindings";
import { type QueryEvent, queryHooks, toD1 } from "./d1";
import { createTestDatabase } from "./database";
import { requester } from "./http";
import { seedAccount } from "./seed";
import { testApp } from "./session";

export interface TemplateResponse {
  template: {
    currentVersion: number;
    definition: AuditDefinition;
    id: string;
    name: string;
    scope: "global" | "organization";
    version: number;
  };
}

export interface TemplateListResponse {
  templates: Array<{
    definition: AuditDefinition;
    id: string;
    name: string;
    savedBy: { email: string; id: string; name: string };
    scope: "global" | "organization";
    version: number;
  }>;
}

export interface TemplateVersionsResponse {
  versions: Array<{ createdBy: { id: string }; version: number }>;
}

export interface RunResponse {
  auditId: string;
}

export interface RunListResponse {
  audits: Array<{ id: string }>;
  nextCursor: string | null;
}

export interface IssueResponse {
  issueId: string;
}

export interface IssueImageResponse {
  image: { contentType: string; filename: string; id: string };
}

export interface TestIdentity {
  organizationId?: string;
  role?: string;
  userId?: string;
}

export interface ActivityResponse {
  events: Array<{
    action: string;
    actor: { apiKey: unknown; email: string; id: string; name: string };
    details: Record<string, unknown>;
    historical: boolean;
    id: number;
    root: { id: string; type: string };
    subject: { id: string; type: string };
  }>;
  nextCursor: string | null;
}

export async function createActivityAudit(
  fixture: ReturnType<typeof createFixture>,
  checkId = "check",
) {
  const created = await jsonRequest<TemplateResponse>(
    fixture,
    "/templates",
    "POST",
    { name: "Activity form" },
  );
  const templateId = created.body.template.id;
  const definition: AuditDefinition = {
    version: 1,
    sections: [
      {
        id: "section",
        title: "Questions",
        items: [
          {
            id: checkId,
            prompt: "Check question",
            required: true,
            responseType: "check",
          },
          {
            id: "text",
            prompt: "Written question",
            required: false,
            responseType: "text",
          },
        ],
      },
    ],
  };
  await jsonRequest(
    fixture,
    `/templates/${templateId}`,
    "PUT",
    { definition, name: "Activity form" },
    { userId: "user-2" },
  );
  const started = await jsonRequest<RunResponse>(
    fixture,
    `/templates/${templateId}/runs`,
    "POST",
  );
  return { auditId: started.body.auditId, templateId };
}

/** An audit run with a high-priority issue assigned to user-1. */
export async function createAuditIssue(
  fixture: ReturnType<typeof createFixture>,
) {
  const { auditId } = await createActivityAudit(fixture);
  const issue = await jsonRequest<IssueResponse>(
    fixture,
    `/runs/${auditId}/issues`,
    "POST",
    {
      assignedTo: "user-1",
      description: "Correct before the next shift.",
      itemId: "check",
      priority: "high",
      title: "Check question",
    },
  );
  return { auditId, issue };
}

/** The statement that activates an uploaded issue image. */
export const imageActivation = "SET size = ?, deletion_pending = 0";

/** The audit and organization an audit update binds last. */
export function auditTarget({ values }: QueryEvent) {
  const [auditId, organizationId] = values.slice(-2);
  if (typeof auditId !== "string" || typeof organizationId !== "string") {
    throw new Error("Expected an audit and organization id.");
  }
  return { auditId, organizationId };
}

export function createFixture(migrations: { before?: string } = {}) {
  const database = legacyDatabase(migrations.before);
  const hooks = queryHooks();
  const storageControl: {
    beforeNextPut?: () => Promise<void>;
    failNextDelete: boolean;
  } = { failNextDelete: false };
  const { bucket, stored } = memoryStorage(new Map(), {
    beforePut: async () => {
      const beforePut = storageControl.beforeNextPut;
      delete storageControl.beforeNextPut;
      await beforePut?.();
    },
  });
  const bindings = testBindings({
    DB: toD1(database, hooks),
    IMAGES: imagesFor(),
    STORAGE: {
      ...bucket,
      delete: async (key: string) => {
        if (storageControl.failNextDelete) {
          storageControl.failNextDelete = false;
          throw new Error("Transient R2 delete failure");
        }
        return bucket.delete(key);
      },
    } as R2Bucket,
    STRIPE_PRO_PRICE_ID: "price_pro_test",
  });
  const app = testApp(
    {
      "/offline": offline,
      "/activity": activity,
      "/admin/audit-templates": adminAuditTemplates,
      "/": audits,
    },
    (context) => ({
      organizationId:
        context.req.header("x-test-organization-id") ?? "org_user-1",
      organizationRole: "owner",
      role: context.req.header("x-test-role") ?? "user",
      userId: context.req.header("x-test-user-id") ?? "user-1",
    }),
  );
  return {
    app,
    bindings,
    database,
    hooks,
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings),
    send: requester(app, bindings),
    storageControl,
    stored,
  };
}

/** A database migrated up to `before`, with the people audits name. */
export function legacyDatabase(before?: string) {
  const database = createTestDatabase(before === undefined ? {} : { before });
  for (const [id, name, email] of [
    ["user-1", "Example Person", "person@example.com"],
    ["user-2", "Second Person", "second@example.com"],
  ] as const) {
    seedAccount(database, { email, emailVerified: false, id, name });
  }
  return database;
}

export async function jsonRequest<T = unknown>(
  fixture: ReturnType<typeof createFixture>,
  path: string,
  method: string,
  body?: unknown,
  identity?: TestIdentity,
) {
  const headers: Record<string, string> = {};
  if (identity?.organizationId) {
    headers["x-test-organization-id"] = identity.organizationId;
  }
  if (identity?.role) headers["x-test-role"] = identity.role;
  if (identity?.userId) headers["x-test-user-id"] = identity.userId;
  return fixture.send<T>(method, path, body, headers);
}

export function imageUpload(
  bytes: BodyInit,
  contentType = "image/png",
  headers: Record<string, string> = {},
): RequestInit {
  return {
    body: bytes,
    headers: { "content-type": contentType, ...headers },
    method: "POST",
  };
}

export function pngBytes() {
  return decodeImageFixture(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
}

export function decodeImageFixture(encoded: string) {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

export function imagesFor(
  dimensions: {
    expectedBytes?: Uint8Array;
    format?: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
    height?: number;
    normalizedBytes?: Uint8Array;
    onInfo?: () => Promise<void> | void;
    onOutput?: (options: ImageOutputOptions) => void;
    onTransform?: (options: Record<string, unknown>) => void;
    width?: number;
  } = {},
) {
  const readValidPng = async (stream: ReadableStream<Uint8Array>) => {
    const actual = new Uint8Array(await new Response(stream).arrayBuffer());
    const expected = dimensions.expectedBytes ?? pngBytes();
    if (
      actual.length !== expected.length ||
      !actual.every((byte, index) => byte === expected[index])
    ) {
      throw new Error("Invalid test image");
    }
    return actual;
  };
  return {
    info: async (stream: ReadableStream<Uint8Array>) => {
      await dimensions.onInfo?.();
      const actual = await readValidPng(stream);
      return {
        fileSize: actual.length,
        format: dimensions.format ?? "image/png",
        height: dimensions.height ?? 1,
        width: dimensions.width ?? 1,
      };
    },
    input: (stream: ReadableStream<Uint8Array>) => {
      const actual = readValidPng(stream);
      const transformer = {
        transform: (options: Record<string, unknown>) => {
          dimensions.onTransform?.(options);
          return transformer;
        },
        output: async (options: ImageOutputOptions) => {
          const supportedOutput = [
            "image/gif",
            "image/jpeg",
            "image/png",
            "image/webp",
          ].includes(options.format);
          if (options.anim !== false || !supportedOutput) {
            throw new Error("Test images must be normalized without animation");
          }
          dimensions.onOutput?.(options);
          const actualBytes = await actual;
          const normalized = dimensions.normalizedBytes ?? actualBytes;
          return {
            contentType: () => options.format,
            image: () => new Blob([normalized]).stream(),
            response: () =>
              new Response(normalized, {
                headers: { "content-type": options.format },
              }),
          };
        },
      };
      return transformer;
    },
  } as unknown as ImagesBinding;
}
