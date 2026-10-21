import { z } from "zod";
import {
  ActivityActorSchema,
  ActivityPageSchema,
  ActivityQuerySchema,
} from "./activity";
import { IssueSchema } from "./issues";
import { route } from "./route";

const AuditTemplateItemSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  required: z.boolean(),
  responseType: z.enum(["check", "text"]),
});
export type AuditTemplateItem = z.infer<typeof AuditTemplateItemSchema>;

const AuditTemplateSectionSchema = z.object({
  id: z.string(),
  items: z.array(AuditTemplateItemSchema),
  title: z.string(),
});
export type AuditTemplateSection = z.infer<typeof AuditTemplateSectionSchema>;

const AuditDefinitionSchema = z.object({
  sections: z.array(AuditTemplateSectionSchema),
  version: z.literal(1),
});
export type AuditDefinition = z.infer<typeof AuditDefinitionSchema>;

/** Someone an audit names: who saved, started, or uploaded, or a member. */
const AuditPersonSchema = z.object({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});
export type AuditPerson = z.infer<typeof AuditPersonSchema>;

const AuditTemplateScopeSchema = z.enum(["global", "organization"]);
export type AuditTemplateScope = z.infer<typeof AuditTemplateScopeSchema>;

const AuditTemplateSchema = z.object({
  createdAt: z.string(),
  currentVersion: z.number(),
  definition: AuditDefinitionSchema,
  description: z.string(),
  id: z.string(),
  name: z.string(),
  savedAt: z.string(),
  savedBy: AuditPersonSchema,
  scope: AuditTemplateScopeSchema,
  /** Draft, published, or unpublished; the stored value is not constrained. */
  status: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});
export type AuditTemplate = z.infer<typeof AuditTemplateSchema>;

const AuditTemplateVersionSchema = z.object({
  createdAt: z.string(),
  createdBy: AuditPersonSchema,
  version: z.number(),
});
export type AuditTemplateVersion = z.infer<typeof AuditTemplateVersionSchema>;

export const AuditTemplateResponseSchema = z.object({
  template: AuditTemplateSchema,
});
export const AuditTemplateListSchema = z.object({
  templates: z.array(AuditTemplateSchema),
});
export const AuditTemplateVersionListSchema = z.object({
  versions: z.array(AuditTemplateVersionSchema),
});
export const AuditTemplateCreateSchema = z.object({ name: z.string() });

/** A template's next version, from the editor's copy of it. */
export const AuditTemplateSaveSchema = z.object({
  definition: AuditDefinitionSchema,
  description: z.string().optional(),
  /** The version the edit started from; a newer one makes the save stale. */
  expectedCurrentVersion: z.number().optional(),
  name: z.string(),
});

const AuditStatusSchema = z.enum(["completed", "in_progress"]);
export type AuditStatus = z.infer<typeof AuditStatusSchema>;

/** Active audits, or in-progress audits someone discarded. */
const AuditRunViewSchema = z.enum(["active", "deleted"]);
export type AuditRunView = z.infer<typeof AuditRunViewSchema>;

const AuditRunFields = {
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: AuditPersonSchema,
  deletedAt: z.string().nullable(),
  /** Null once the discarding account has been deleted. */
  deletedBy: AuditPersonSchema.nullable(),
  id: z.string(),
  status: AuditStatusSchema,
  templateName: z.string(),
  templateVersion: z.number().nullable(),
  updatedAt: z.string(),
};

const AuditSummarySchema = z.object({
  ...AuditRunFields,
  issueCount: z.number(),
  responseCount: z.number(),
});
export type AuditSummary = z.infer<typeof AuditSummarySchema>;

const AuditRunSchema = z.object({
  ...AuditRunFields,
  /** Who last saved each answer, by item id. */
  answerActivity: z.record(
    z.string(),
    z.object({ actor: ActivityActorSchema, occurredAt: z.string() }),
  ),
  definition: AuditDefinitionSchema,
  responses: z.record(z.string(), z.string()),
  revision: z.number(),
  templateId: z.string().nullable(),
});
export type AuditRun = z.infer<typeof AuditRunSchema>;

const AuditIssueImageSchema = z.object({
  contentType: z.string(),
  createdAt: z.string(),
  filename: z.string(),
  id: z.string(),
  size: z.number(),
  uploadedBy: AuditPersonSchema,
});
export type AuditIssueImage = z.infer<typeof AuditIssueImageSchema>;

const AuditIssuePrioritySchema = IssueSchema.shape.priority;
export type AuditIssuePriority = z.infer<typeof AuditIssuePrioritySchema>;
const AuditIssueStatusSchema = IssueSchema.shape.status;

const AuditIssueSchema = z.object({
  assignedTo: z.string().nullable(),
  assigneeEmail: z.string().nullable(),
  assigneeName: z.string().nullable(),
  createdAt: z.string(),
  createdBy: AuditPersonSchema,
  description: z.string(),
  id: z.string(),
  images: z.array(AuditIssueImageSchema),
  itemId: z.string(),
  priority: AuditIssuePrioritySchema,
  status: AuditIssueStatusSchema,
  title: z.string(),
  updatedAt: z.string(),
});
export type AuditIssue = z.infer<typeof AuditIssueSchema>;

const AuditDetailSchema = z.object({
  audit: AuditRunSchema,
  issues: z.array(AuditIssueSchema),
  members: z.array(AuditPersonSchema),
});
export type AuditDetail = z.infer<typeof AuditDetailSchema>;

const AuditIssueCreateSchema = z.object({
  assignedTo: z.string().nullable().optional(),
  description: z.string().optional(),
  itemId: z.string(),
  /** Medium unless given. */
  priority: AuditIssuePrioritySchema.optional(),
  title: z.string(),
});
export type AuditIssueInput = z.infer<typeof AuditIssueCreateSchema>;

const AuditIssueUpdateSchema = z.object({
  /** Null or empty unassigns the issue. */
  assignedTo: z.string().nullable().optional(),
  status: AuditIssueStatusSchema.optional(),
});
export type AuditIssueUpdate = z.infer<typeof AuditIssueUpdateSchema>;

export const auditsRoutes = {
  listTemplates: route({
    method: "GET",
    path: "/api/audits/templates",
    response: AuditTemplateListSchema,
  }),
  createTemplate: route({
    method: "POST",
    path: "/api/audits/templates",
    // Global templates are created through Global Audits.
    body: AuditTemplateCreateSchema.extend({
      scope: z.literal("organization").optional(),
    }),
    response: AuditTemplateResponseSchema,
  }),
  copyTemplate: route({
    method: "POST",
    path: "/api/audits/templates/:id/copies",
    body: AuditTemplateSaveSchema,
    response: AuditTemplateResponseSchema,
  }),
  templateVersions: route({
    method: "GET",
    path: "/api/audits/templates/:id/versions",
    response: AuditTemplateVersionListSchema,
  }),
  templateVersion: route({
    method: "GET",
    path: "/api/audits/templates/:id/versions/:version",
    response: AuditTemplateResponseSchema,
  }),
  getTemplate: route({
    method: "GET",
    path: "/api/audits/templates/:id",
    response: AuditTemplateResponseSchema,
  }),
  templateActivity: route({
    method: "GET",
    path: "/api/audits/templates/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  updateTemplate: route({
    method: "PUT",
    path: "/api/audits/templates/:id",
    body: AuditTemplateSaveSchema,
    response: AuditTemplateResponseSchema,
  }),
  start: route({
    method: "POST",
    path: "/api/audits/templates/:id/runs",
    response: z.object({ auditId: z.string() }),
  }),
  listRuns: route({
    method: "GET",
    path: "/api/audits/runs",
    query: z.object({
      cursor: z.string().optional(),
      view: AuditRunViewSchema.optional(),
    }),
    response: z.object({
      audits: z.array(AuditSummarySchema),
      nextCursor: z.string().nullable(),
    }),
  }),
  getRun: route({
    method: "GET",
    path: "/api/audits/runs/:id",
    response: AuditDetailSchema,
  }),
  runActivity: route({
    method: "GET",
    path: "/api/audits/runs/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  saveRun: route({
    method: "PATCH",
    path: "/api/audits/runs/:id",
    body: z.object({
      /** The revision the answers were edited from. */
      expectedRevision: z.number(),
      responses: z.record(z.string(), z.string()),
      /** Unchanged unless given. */
      status: AuditStatusSchema.optional(),
    }),
    response: z.object({ status: AuditStatusSchema, updatedAt: z.string() }),
  }),
  createIssue: route({
    method: "POST",
    path: "/api/audits/runs/:id/issues",
    body: AuditIssueCreateSchema,
    response: z.object({ issueId: z.string() }),
  }),
  updateIssue: route({
    method: "PATCH",
    path: "/api/audits/issues/:id",
    body: AuditIssueUpdateSchema,
    response: z.object({
      assignedTo: z.string().nullable(),
      status: AuditIssueStatusSchema,
      updatedAt: z.string(),
    }),
  }),
  /** Moves an in-progress audit to the Deleted view, where it stays read-only. */
  discardRun: route({
    method: "DELETE",
    path: "/api/audits/runs/:id",
    response: z.object({ deletedAt: z.string() }),
  }),
  uploadIssueImage: route({
    method: "POST",
    path: "/api/audits/issues/:issueId/images",
    query: z.object({ filename: z.string().optional() }),
    body: "file",
    response: z.object({ image: AuditIssueImageSchema }),
  }),
  issueImage: route({
    method: "GET",
    path: "/api/audits/issues/:issueId/images/:imageId",
    query: z.object({ variant: z.literal("thumbnail").optional() }),
    response: "file",
  }),
  /**
   * Answers 204 once the image is gone, or 202 when its stored file is left
   * for cleanup to remove.
   */
  deleteIssueImage: route({
    method: "DELETE",
    path: "/api/audits/issues/:issueId/images/:imageId",
    response: z.object({ cleanupPending: z.literal(true) }).optional(),
  }),
};
