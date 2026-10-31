import { z } from "zod";
import {
  ActivityActorSchema,
  ActivityPageSchema,
  ActivityQuerySchema,
} from "./activity";
import {
  ChecklistIdSchema,
  optionalText,
  PersonSchema,
  requiredText,
} from "./fields";
import { IssueSchema, NewIssueSchema } from "./issues";
import { route } from "./route";
import { auditLimits } from "./rules";

const AuditTemplateItemSchema = z.object({
  id: ChecklistIdSchema,
  prompt: requiredText(auditLimits.prompt),
  required: z.boolean(),
  responseType: z.enum(["check", "text"]),
});
export type AuditTemplateItem = z.infer<typeof AuditTemplateItemSchema>;

const AuditTemplateSectionSchema = z.object({
  id: ChecklistIdSchema,
  items: z.array(AuditTemplateItemSchema).max(auditLimits.itemsPerSection),
  title: requiredText(auditLimits.sectionTitle),
});
export type AuditTemplateSection = z.infer<typeof AuditTemplateSectionSchema>;

/** A checklist, as saved and as served. */
export const AuditDefinitionSchema = z.object({
  sections: z
    .array(AuditTemplateSectionSchema)
    .min(1)
    .max(auditLimits.sections),
  version: z.literal(1),
});
export type AuditDefinition = z.infer<typeof AuditDefinitionSchema>;

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
  savedBy: PersonSchema,
  scope: AuditTemplateScopeSchema,
  /** Draft, published, or unpublished; the stored value is not constrained. */
  status: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});
export type AuditTemplate = z.infer<typeof AuditTemplateSchema>;

const AuditTemplateVersionSchema = z.object({
  createdAt: z.string(),
  createdBy: PersonSchema,
  version: z.number(),
});
export type AuditTemplateVersion = z.infer<typeof AuditTemplateVersionSchema>;

export const AuditTemplateResponseSchema = z.object({
  template: AuditTemplateSchema,
});
export const AuditTemplateListSchema = z.object({
  templates: z.array(AuditTemplateSchema),
});

/** A form in a forms list, with how many audits have been started from it. */
const AuditTemplateSummarySchema = AuditTemplateSchema.extend({
  /** Audits started from any version of the form, not counting discarded ones. */
  auditCount: z.int().nonnegative(),
});
export type AuditTemplateSummary = z.infer<typeof AuditTemplateSummarySchema>;

export const AuditTemplateSummaryListSchema = z.object({
  templates: z.array(AuditTemplateSummarySchema),
});

/**
 * Publishes or unpublishes a form as it is saved; its status is kept
 * otherwise. Only published forms are offered to projects.
 */
export const TemplatePublicationSchema = z
  .enum(["published", "unpublished"], {
    error: "Template status is invalid.",
  })
  .optional();
export type TemplatePublication = z.infer<typeof TemplatePublicationSchema>;
export const AuditTemplateVersionListSchema = z.object({
  versions: z.array(AuditTemplateVersionSchema),
});
const templateNameRule = "A template name is required.";
const TemplateNameSchema = requiredText(auditLimits.name, templateNameRule);

export const AuditTemplateCreateSchema = z.object(
  { name: TemplateNameSchema },
  { error: templateNameRule },
);

/**
 * A template's next version, from the editor's copy of it. A request that
 * breaks a rule without a message of its own has an invalid definition.
 */
export const AuditTemplateSaveSchema = z.object(
  {
    name: TemplateNameSchema,
    definition: AuditDefinitionSchema,
    description: z
      .string()
      .trim()
      .max(
        auditLimits.description,
        "Descriptions are limited to 2,000 characters.",
      )
      .nullish()
      .transform((description) => description ?? ""),
    /** The version the edit started from; a newer one makes the save stale. */
    expectedCurrentVersion: z
      .int({ error: "The template version is invalid." })
      .min(1, "The template version is invalid.")
      .optional(),
  },
  { error: templateNameRule },
);

const AuditStatusSchema = z.enum(["completed", "in_progress"]);
export type AuditStatus = z.infer<typeof AuditStatusSchema>;

const auditRevisionRule =
  "A valid audit revision is required. Reload it before saving.";

/** Active audits, or in-progress audits someone discarded. */
const AuditRunViewSchema = z.enum(["active", "deleted"]);
export type AuditRunView = z.infer<typeof AuditRunViewSchema>;

const AuditRunFields = {
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: PersonSchema,
  deletedAt: z.string().nullable(),
  /** Null once the discarding account has been deleted. */
  deletedBy: PersonSchema.nullable(),
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
  uploadedBy: PersonSchema,
});
export type AuditIssueImage = z.infer<typeof AuditIssueImageSchema>;

const AuditIssuePrioritySchema = IssueSchema.shape.priority;
const AuditIssueStatusSchema = IssueSchema.shape.status;

const AuditIssueSchema = z.object({
  assignedTo: z.string().nullable(),
  assigneeEmail: z.string().nullable(),
  assigneeName: z.string().nullable(),
  createdAt: z.string(),
  createdBy: PersonSchema,
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
  members: z.array(PersonSchema),
});
export type AuditDetail = z.infer<typeof AuditDetailSchema>;

const AuditIssueCreateSchema = NewIssueSchema.extend({
  /** The checklist item the issue is about. */
  itemId: ChecklistIdSchema,
});
export type AuditIssueInput = z.input<typeof AuditIssueCreateSchema>;

const AuditIssueUpdateSchema = z
  .object(
    {
      status: z
        .enum(AuditIssueStatusSchema.options, {
          error: "Issue status must be open or resolved.",
        })
        .optional(),
      /** Null or empty unassigns the issue. */
      assignedTo: optionalText(
        z.string().trim().max(200),
        "Issue assignee is invalid.",
      ),
    },
    { error: "Invalid issue update." },
  )
  .refine(
    (changes) =>
      changes.status !== undefined || changes.assignedTo !== undefined,
    "No issue changes were provided.",
  );
export type AuditIssueUpdate = z.input<typeof AuditIssueUpdateSchema>;

export const auditsRoutes = {
  listTemplates: route({
    method: "GET",
    path: "/api/audits/templates",
    response: AuditTemplateSummaryListSchema,
  }),
  createTemplate: route({
    method: "POST",
    path: "/api/audits/templates",
    // Global templates are created through Global Audits.
    body: AuditTemplateCreateSchema.extend({
      scope: z
        .literal("organization", { error: "Template scope is invalid." })
        .optional(),
    }),
    response: AuditTemplateResponseSchema,
  }),
  copyTemplate: route({
    method: "POST",
    path: "/api/audits/templates/:id/copies",
    body: AuditTemplateSaveSchema.extend({
      /** The published global version the copy starts from, kept as its source. */
      sourceVersion: z
        .int({ error: "The template version is invalid." })
        .min(1, "The template version is invalid.")
        .optional(),
    }),
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
    /** Only organization managers can publish or unpublish. */
    body: AuditTemplateSaveSchema.extend({ status: TemplatePublicationSchema }),
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
    // The API checks each answer against the audit's own checklist.
    body: z.object(
      {
        /** The revision the answers were edited from. */
        expectedRevision: z
          .int({ error: auditRevisionRule })
          .min(0, auditRevisionRule),
        responses: z.record(
          z.string(),
          z
            .string({ error: "Invalid audit responses." })
            .max(auditLimits.answer, "Invalid audit responses."),
          { error: "Invalid audit responses." },
        ),
        /** Unchanged unless given. */
        status: z
          .enum(AuditStatusSchema.options, { error: "Invalid audit status." })
          .optional(),
      },
      { error: "Invalid audit update." },
    ),
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
