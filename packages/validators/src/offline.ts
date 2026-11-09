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

const OfflineResponsesSchema = z.record(
  z.string().max(100),
  z.string().max(2000),
);

// A receipt's digest is of the parsed operation, so a field's keys, order,
// and normalization must not change between releases: a retry of work
// synced before an upgrade must hash the same.
export const OfflineOperationSchema = z.discriminatedUnion("type", [
  /**
   * Puts an audit started on a device on the server, in progress, with its
   * answers so far. Its ID is the audit's, and it leaves revision 1.
   */
  z.object({
    id: z.uuid(),
    type: z.literal("auditStart"),
    /** The project the audit was started for on the device. */
    projectId: z.string().min(1).max(200),
    templateId: z.string().min(1).max(200),
    templateVersion: z.number().int().positive(),
    responses: OfflineResponsesSchema,
  }),
  /**
   * Saves a device audit's answers over the revision its last write left,
   * and completes it when `completion` is given. Any other change to the
   * audit since makes it stale.
   */
  z.object({
    id: z.uuid(),
    type: z.literal("auditSave"),
    auditId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    responses: OfflineResponsesSchema,
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
  apply: route({
    method: "POST",
    path: "/api/offline/operations",
    body: OfflineScopeSchema.extend({ operation: OfflineOperationSchema }),
    /** The audit or issue the operation created or saved. */
    response: z.object({ resourceId: z.string() }),
  }),
  uploadImage: route({
    method: "PUT",
    path: "/api/offline/issues/:issueId/images/:imageId",
    body: "file",
    query: OfflineScopeSchema.extend({ filename: z.string() }),
    response: auditsRoutes.uploadIssueImage.response,
  }),
};
