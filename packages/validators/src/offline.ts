import { z } from "zod";
import { AuditTemplateSchema, auditsRoutes } from "./audits";
import { PersonSchema } from "./fields";
import { issueLimits, issuePriorities } from "./issueRules";
import { route } from "./route";
import { auditLimits } from "./rules";

export const OfflineScopeSchema = z.object({
  organizationId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
});
export type OfflineScope = z.infer<typeof OfflineScopeSchema>;

/** An answer and the UTC time it was given on the device. */
const OfflineAnswerSchema = z.object({
  value: z.string().max(2000),
  at: z.iso.datetime(),
});

// A receipt's digest is of the parsed operation, so a field's keys, order,
// and normalization must not change between releases: a retry of work
// synced before an upgrade must hash the same.
export const OfflineOperationSchema = z.discriminatedUnion("type", [
  /**
   * Puts an audit started on a device on the server, in progress, with its
   * answers so far. Its ID is the audit's.
   */
  z.object({
    id: z.uuid(),
    type: z.literal("auditStart"),
    /** The project the audit was started for on the device. */
    projectId: z.string().min(1).max(200),
    templateId: z.string().min(1).max(200),
    templateVersion: z.number().int().positive(),
    answers: z.record(z.string().max(100), OfflineAnswerSchema),
  }),
  /**
   * Merges the answers a device gave since its last write into the server's,
   * last writer wins by each answer's time, and completes the audit when
   * `completion` is given.
   */
  z.object({
    id: z.uuid(),
    type: z.literal("auditSave"),
    auditId: z.uuid(),
    answers: z.record(
      z.string().max(100),
      OfflineAnswerSchema.extend({
        /** The version of the server answer the device showed when it was given. */
        base: z.string().min(1).max(200).nullable(),
      }),
    ),
    /** The device-reported times, kept apart from the server's own. */
    completion: z
      .object({ startedAt: z.iso.datetime(), completedAt: z.iso.datetime() })
      .optional(),
  }),
  z.object({
    id: z.uuid(),
    type: z.literal("issue"),
    title: z.string().trim().min(1).max(issueLimits.title),
    description: z.string().max(issueLimits.description),
    priority: z.enum(issuePriorities),
    assignedTo: z.string().min(1).max(200).nullable(),
    auditId: z.uuid().optional(),
    itemId: z.string().min(1).max(auditLimits.itemId).optional(),
  }),
]);
export type OfflineOperation = z.infer<typeof OfflineOperationSchema>;

export const OfflineSyncQuerySchema = OfflineScopeSchema.extend({
  /** The cursor of the last sync this device stored, if any. */
  after: z.string().max(100).optional(),
});

/** A project as a device keeps it: its name and the forms turned on. */
const OfflineProjectSchema = z.object({
  description: z.string(),
  /** The published forms turned on for the project, by template ID. */
  formIds: z.array(z.string()),
  id: z.string(),
  name: z.string(),
});
export type OfflineProject = z.infer<typeof OfflineProjectSchema>;

/**
 * What a device keeps for its person: their projects, those projects'
 * published forms, and the people issues can be assigned to. `changed` is
 * false when nothing changed since `after`; the rest is left out then. Every
 * change replaces the whole set, so a form, project, or membership that is
 * gone is simply absent.
 */
const OfflineSyncSchema = z.discriminatedUnion("changed", [
  z.object({ changed: z.literal(false), cursor: z.string() }),
  z.object({
    changed: z.literal(true),
    cursor: z.string(),
    forms: z.array(AuditTemplateSchema),
    members: z.array(PersonSchema),
    projects: z.array(OfflineProjectSchema),
  }),
]);
export type OfflineSync = z.infer<typeof OfflineSyncSchema>;

/**
 * The server's copy of an audit as a device merges it: its status and its
 * answers, each with the time it was given and the version of the write that
 * set it, as of `revision`. A cleared answer keeps both with a null value.
 */
const OfflineAuditStateSchema = z.object({
  answers: z.record(
    z.string(),
    z.object({
      at: z.string().nullable(),
      value: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
  deleted: z.boolean(),
  id: z.string(),
  revision: z.number(),
  status: z.enum(["completed", "in_progress"]),
});
export type OfflineAuditState = z.infer<typeof OfflineAuditStateSchema>;

export const offlineRoutes = {
  images: route({
    method: "GET",
    path: "/api/offline/issues/:issueId/images",
    response: z.object({
      images: z.array(auditsRoutes.uploadIssueImage.response.shape.image),
    }),
  }),
  sync: route({
    method: "GET",
    path: "/api/offline/sync",
    query: OfflineSyncQuerySchema,
    response: OfflineSyncSchema,
  }),
  /** The server's copy of an audit, for a device holding it. */
  audit: route({
    method: "GET",
    path: "/api/offline/audits/:auditId",
    query: OfflineScopeSchema,
    response: OfflineAuditStateSchema,
  }),
  apply: route({
    method: "POST",
    path: "/api/offline/operations",
    body: OfflineScopeSchema.extend({ operation: OfflineOperationSchema }),
    response: z.object({
      /** The audit or issue the operation created or saved. */
      resourceId: z.string(),
      /** For an audit write, the audit as the server now has it. */
      audit: OfflineAuditStateSchema.optional(),
    }),
  }),
  uploadImage: route({
    method: "PUT",
    path: "/api/offline/issues/:issueId/images/:imageId",
    body: "file",
    query: OfflineScopeSchema.extend({ filename: z.string() }),
    response: auditsRoutes.uploadIssueImage.response,
  }),
};
