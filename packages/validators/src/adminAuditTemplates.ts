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

/**
 * Days a discarded global form stays restorable, counted from its discard
 * (the discarded version's save time); the purge job deletes it afterwards.
 */
export const discardedTemplateRetentionDays = 30;

/** Global forms in use, or discarded forms that can still be restored. */
const AdminTemplateViewSchema = z.enum(["active", "discarded"]);
export type AdminTemplateView = z.infer<typeof AdminTemplateViewSchema>;

const ExpectedVersionSchema = z.object(
  { expectedCurrentVersion: z.int() },
  { error: "The current template version is required." },
);

/** Global audit templates, which root admins manage outside any organization. */
export const adminAuditTemplatesRoutes = {
  /**
   * Audit counts cover every organization. Discarded forms are listed most
   * recently discarded first; their `savedAt` and `savedBy` record the discard.
   */
  list: route({
    method: "GET",
    path: "/api/admin/audit-templates",
    query: z.object({ view: AdminTemplateViewSchema.optional() }),
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
  /**
   * Discards a draft or unpublished form, which then moves to the discarded
   * view until it is restored or purged.
   */
  discard: route({
    method: "DELETE",
    path: "/api/admin/audit-templates/:id",
    body: ExpectedVersionSchema,
    response: z.object({ discarded: z.literal(true) }),
  }),
  /**
   * Restores a discarded form as a new version with the status it had before
   * the discard: a draft, or an unpublished form (never published).
   */
  restore: route({
    method: "POST",
    path: "/api/admin/audit-templates/:id/restore",
    body: ExpectedVersionSchema,
    response: AuditTemplateResponseSchema,
  }),
};
