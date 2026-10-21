import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import {
  AuditTemplateCreateSchema,
  AuditTemplateListSchema,
  AuditTemplateResponseSchema,
  AuditTemplateSaveSchema,
  AuditTemplateVersionListSchema,
} from "./audits";
import { route } from "./route";

/** Global audit templates, which root admins manage outside any organization. */
export const adminAuditTemplatesRoutes = {
  list: route({
    method: "GET",
    path: "/api/admin/audit-templates",
    response: AuditTemplateListSchema,
  }),
  create: route({
    method: "POST",
    path: "/api/admin/audit-templates",
    body: AuditTemplateCreateSchema,
    response: AuditTemplateResponseSchema,
  }),
  versions: route({
    method: "GET",
    path: "/api/admin/audit-templates/:id/versions",
    response: AuditTemplateVersionListSchema,
  }),
  version: route({
    method: "GET",
    path: "/api/admin/audit-templates/:id/versions/:version",
    response: AuditTemplateResponseSchema,
  }),
  activity: route({
    method: "GET",
    path: "/api/admin/audit-templates/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  get: route({
    method: "GET",
    path: "/api/admin/audit-templates/:id",
    response: AuditTemplateResponseSchema,
  }),
  update: route({
    method: "PUT",
    path: "/api/admin/audit-templates/:id",
    body: AuditTemplateSaveSchema.extend({
      /** Publishes or unpublishes the form; its status is kept otherwise. */
      status: z.enum(["published", "unpublished"]).optional(),
    }),
    response: AuditTemplateResponseSchema,
  }),
  /** Discards a draft, which then leaves Global Audits. */
  discard: route({
    method: "DELETE",
    path: "/api/admin/audit-templates/:id",
    body: z.object({ expectedCurrentVersion: z.number() }),
    response: z.object({ discarded: z.literal(true) }),
  }),
};
