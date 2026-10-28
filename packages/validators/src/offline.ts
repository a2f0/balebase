import { z } from "zod";
import { auditsRoutes } from "./audits";
import { PersonSchema } from "./fields";
import { issueLimits, issuePriorities } from "./issueRules";
import { route } from "./route";
import { auditLimits } from "./rules";

export const OfflineScopeSchema = z.object({
  organizationId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
});
export type OfflineScope = z.infer<typeof OfflineScopeSchema>;

export const OfflineOperationSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.uuid(),
    type: z.literal("audit"),
    templateId: z.string().min(1).max(200),
    templateVersion: z.number().int().positive(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    responses: z.record(z.string().max(100), z.string().max(2000)),
  }),
  // A receipt's digest is of the parsed operation, so these fields keep the
  // keys, order, and normalization of earlier releases: a retry of work
  // synced before an upgrade must hash the same.
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

export const offlineRoutes = {
  images: route({
    method: "GET",
    path: "/api/offline/issues/:issueId/images",
    response: z.object({
      images: z.array(auditsRoutes.uploadIssueImage.response.shape.image),
    }),
  }),
  forms: route({
    method: "GET",
    path: "/api/offline/forms",
    query: OfflineScopeSchema,
    response: auditsRoutes.listTemplates.response.extend({
      members: z.array(PersonSchema),
    }),
  }),
  apply: route({
    method: "POST",
    path: "/api/offline/operations",
    body: OfflineScopeSchema.extend({ operation: OfflineOperationSchema }),
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
