import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import {
  FormTemplateCreateSchema,
  FormTemplateResponseSchema,
  FormTemplateSaveSchema,
  FormTemplateSummaryListSchema,
  FormTemplateVersionListSchema,
  TemplatePublicationSchema,
} from "./forms";
import { route } from "./route";

/** Global templates in use, or discarded templates that can still be restored. */
const AdminTemplateViewSchema = z.enum(["active", "discarded"]);
export type AdminTemplateView = z.infer<typeof AdminTemplateViewSchema>;

const ExpectedVersionSchema = z.object(
  { expectedCurrentVersion: z.int() },
  { error: "The current template version is required." },
);

/** Global form templates, which root admins manage outside any organization. */
export const adminFormTemplatesRoutes = {
  /**
   * Form counts cover every organization. Discarded templates are listed most
   * recently discarded first; their `savedAt` and `savedBy` record the discard.
   */
  list: route({
    method: "GET",
    path: "/api/admin/form-templates",
    query: z.object({ view: AdminTemplateViewSchema.optional() }),
    response: FormTemplateSummaryListSchema,
  }),
  create: route({
    method: "POST",
    path: "/api/admin/form-templates",
    body: FormTemplateCreateSchema,
    response: FormTemplateResponseSchema,
  }),
  versions: route({
    method: "GET",
    path: "/api/admin/form-templates/:id/versions",
    response: FormTemplateVersionListSchema,
  }),
  version: route({
    method: "GET",
    path: "/api/admin/form-templates/:id/versions/:version",
    response: FormTemplateResponseSchema,
  }),
  activity: route({
    method: "GET",
    path: "/api/admin/form-templates/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  get: route({
    method: "GET",
    path: "/api/admin/form-templates/:id",
    response: FormTemplateResponseSchema,
  }),
  update: route({
    method: "PUT",
    path: "/api/admin/form-templates/:id",
    body: FormTemplateSaveSchema.extend({ status: TemplatePublicationSchema }),
    response: FormTemplateResponseSchema,
  }),
  /**
   * Discards a draft or unpublished template, which then moves to the discarded
   * view until it is restored or purged.
   */
  discard: route({
    method: "DELETE",
    path: "/api/admin/form-templates/:id",
    body: ExpectedVersionSchema,
    response: z.object({ discarded: z.literal(true) }),
  }),
  /**
   * Restores a discarded template as a new version with the status it had before
   * the discard: a draft, or an unpublished template (never published).
   */
  restore: route({
    method: "POST",
    path: "/api/admin/form-templates/:id/restore",
    body: ExpectedVersionSchema,
    response: FormTemplateResponseSchema,
  }),
};
