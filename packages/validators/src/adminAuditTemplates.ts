import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import {
  AuditTemplateCreateSchema,
  AuditTemplateResponseSchema,
  AuditTemplateSaveSchema,
  AuditTemplateSummaryListSchema,
  AuditTemplateVersionListSchema,
  TemplatePublicationSchema,
} from "./audits";
import { route } from "./route";

/** Global audit templates, which root admins manage outside any organization. */
export const adminAuditTemplatesRoutes = {
  /** Audit counts cover every organization. */
  list: route({
    method: "GET",
    path: "/api/admin/audit-templates",
    response: AuditTemplateSummaryListSchema,
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
    body: AuditTemplateSaveSchema.extend({ status: TemplatePublicationSchema }),
    response: AuditTemplateResponseSchema,
  }),
  /** Discards a draft or unpublished form, which then leaves Global Audits. */
  discard: route({
    method: "DELETE",
    path: "/api/admin/audit-templates/:id",
    body: z.object(
      { expectedCurrentVersion: z.int() },
      { error: "The current template version is required." },
    ),
    response: z.object({ discarded: z.literal(true) }),
  }),
};
