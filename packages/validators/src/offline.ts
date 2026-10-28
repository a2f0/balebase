import { z } from "zod";
import { auditsRoutes } from "./audits";
import { PersonSchema } from "./fields";
import { NewIssueSchema } from "./issues";
import { route } from "./route";

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
  // Keys stay in this order: a receipt's digest is of the parsed operation.
  z.object({
    id: z.uuid(),
    type: z.literal("issue"),
    title: NewIssueSchema.shape.title,
    description: NewIssueSchema.shape.description,
    priority: NewIssueSchema.shape.priority,
    assignedTo: NewIssueSchema.shape.assignedTo,
    auditId: z.uuid().optional(),
    itemId: z.string().trim().min(1).max(100).optional(),
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
