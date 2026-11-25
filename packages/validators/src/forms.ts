import { z } from "zod";
import {
  ActivityActorSchema,
  ActivityPageSchema,
  ActivityQuerySchema,
} from "./activity";
import {
  DefinitionIdSchema,
  optionalText,
  PersonSchema,
  requiredText,
} from "./fields";
import { IssueSchema, NewIssueSchema } from "./issues";
import { route } from "./route";
import { formLimits } from "./rules";

const FormTemplateItemSchema = z.object({
  id: DefinitionIdSchema,
  prompt: requiredText(formLimits.prompt),
  required: z.boolean(),
  responseType: z.enum(["check", "text"]),
});
export type FormTemplateItem = z.infer<typeof FormTemplateItemSchema>;

const FormTemplateSectionSchema = z.object({
  id: DefinitionIdSchema,
  items: z.array(FormTemplateItemSchema).max(formLimits.itemsPerSection),
  title: requiredText(formLimits.sectionTitle),
});
export type FormTemplateSection = z.infer<typeof FormTemplateSectionSchema>;

/** A template definition, as saved and as served. */
export const FormDefinitionSchema = z.object({
  sections: z.array(FormTemplateSectionSchema).min(1).max(formLimits.sections),
  version: z.literal(1),
});
export type FormDefinition = z.infer<typeof FormDefinitionSchema>;

const FormTemplateScopeSchema = z.enum(["global", "organization"]);
export type FormTemplateScope = z.infer<typeof FormTemplateScopeSchema>;

export const FormTemplateSchema = z.object({
  createdAt: z.string(),
  currentVersion: z.number(),
  definition: FormDefinitionSchema,
  description: z.string(),
  id: z.string(),
  name: z.string(),
  savedAt: z.string(),
  savedBy: PersonSchema,
  scope: FormTemplateScopeSchema,
  /** Draft, published, or unpublished; the stored value is not constrained. */
  status: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});
export type FormTemplate = z.infer<typeof FormTemplateSchema>;

const FormTemplateVersionSchema = z.object({
  createdAt: z.string(),
  createdBy: PersonSchema,
  version: z.number(),
});
export type FormTemplateVersion = z.infer<typeof FormTemplateVersionSchema>;

export const FormTemplateResponseSchema = z.object({
  template: FormTemplateSchema,
});
/** A template in a templates list, with how many forms have been started from it. */
const FormTemplateSummarySchema = FormTemplateSchema.extend({
  /** Forms started from any version of the template, not counting discarded ones. */
  formCount: z.int().nonnegative(),
});
export type FormTemplateSummary = z.infer<typeof FormTemplateSummarySchema>;

export const FormTemplateSummaryListSchema = z.object({
  templates: z.array(FormTemplateSummarySchema),
});

/**
 * Publishes or unpublishes a template as it is saved; its status is kept
 * otherwise. Only published templates are offered to projects.
 */
export const TemplatePublicationSchema = z
  .enum(["published", "unpublished"], {
    error: "Template status is invalid.",
  })
  .optional();
export type TemplatePublication = z.infer<typeof TemplatePublicationSchema>;
export const FormTemplateVersionListSchema = z.object({
  versions: z.array(FormTemplateVersionSchema),
});
const templateNameRule = "A template name is required.";
const TemplateNameSchema = requiredText(formLimits.name, templateNameRule);

export const FormTemplateCreateSchema = z.object(
  { name: TemplateNameSchema },
  { error: templateNameRule },
);

/**
 * A template's next version, from the editor's copy of it. A request that
 * breaks a rule without a message of its own has an invalid definition.
 */
export const FormTemplateSaveSchema = z.object(
  {
    name: TemplateNameSchema,
    definition: FormDefinitionSchema,
    description: z
      .string()
      .trim()
      .max(
        formLimits.description,
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

const FormStatusSchema = z.enum(["completed", "in_progress"]);
export type FormStatus = z.infer<typeof FormStatusSchema>;

const formRevisionRule =
  "A valid form revision is required. Reload it before saving.";

/** Active forms, or in-progress forms someone discarded. */
const FormRunViewSchema = z.enum(["active", "deleted"]);
export type FormRunView = z.infer<typeof FormRunViewSchema>;

const FormRunFields = {
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: PersonSchema,
  deletedAt: z.string().nullable(),
  /** Null once the discarding account has been deleted. */
  deletedBy: PersonSchema.nullable(),
  id: z.string(),
  /** The project the form belongs to; it may since have been deleted. */
  project: z.object({
    deleted: z.boolean(),
    id: z.string(),
    name: z.string(),
  }),
  status: FormStatusSchema,
  templateName: z.string(),
  templateVersion: z.number().nullable(),
  updatedAt: z.string(),
};

const FormSummarySchema = z.object({
  ...FormRunFields,
  issueCount: z.number(),
  responseCount: z.number(),
});
export type FormSummary = z.infer<typeof FormSummarySchema>;

const FormRunSchema = z.object({
  ...FormRunFields,
  /** Who last saved each answer, by item id. */
  answerActivity: z.record(
    z.string(),
    z.object({ actor: ActivityActorSchema, occurredAt: z.string() }),
  ),
  definition: FormDefinitionSchema,
  responses: z.record(z.string(), z.string()),
  revision: z.number(),
  templateId: z.string().nullable(),
});
export type FormRun = z.infer<typeof FormRunSchema>;

const FormIssueImageSchema = z.object({
  contentType: z.string(),
  createdAt: z.string(),
  filename: z.string(),
  id: z.string(),
  size: z.number(),
  uploadedBy: PersonSchema,
});
export type FormIssueImage = z.infer<typeof FormIssueImageSchema>;

const FormIssuePrioritySchema = IssueSchema.shape.priority;
const FormIssueStatusSchema = IssueSchema.shape.status;

const FormIssueSchema = z.object({
  assignedTo: z.string().nullable(),
  assigneeEmail: z.string().nullable(),
  assigneeName: z.string().nullable(),
  createdAt: z.string(),
  createdBy: PersonSchema,
  description: z.string(),
  id: z.string(),
  images: z.array(FormIssueImageSchema),
  itemId: z.string(),
  priority: FormIssuePrioritySchema,
  status: FormIssueStatusSchema,
  title: z.string(),
  updatedAt: z.string(),
});
export type FormIssue = z.infer<typeof FormIssueSchema>;

const FormDetailSchema = z.object({
  form: FormRunSchema,
  issues: z.array(FormIssueSchema),
  members: z.array(PersonSchema),
});
export type FormDetail = z.infer<typeof FormDetailSchema>;

const FormIssueCreateSchema = NewIssueSchema.extend({
  /** The question the issue is about. */
  itemId: DefinitionIdSchema,
});
export type FormIssueInput = z.input<typeof FormIssueCreateSchema>;

const FormIssueUpdateSchema = z
  .object(
    {
      status: z
        .enum(FormIssueStatusSchema.options, {
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
export type FormIssueUpdate = z.input<typeof FormIssueUpdateSchema>;

export const formsRoutes = {
  listTemplates: route({
    method: "GET",
    path: "/api/forms/templates",
    response: FormTemplateSummaryListSchema,
  }),
  createTemplate: route({
    method: "POST",
    path: "/api/forms/templates",
    // Global templates are created through Global templates.
    body: FormTemplateCreateSchema.extend({
      scope: z
        .literal("organization", { error: "Template scope is invalid." })
        .optional(),
    }),
    response: FormTemplateResponseSchema,
  }),
  copyTemplate: route({
    method: "POST",
    path: "/api/forms/templates/:id/copies",
    body: FormTemplateSaveSchema.extend({
      /** The published global version the copy starts from, kept as its source. */
      sourceVersion: z
        .int({ error: "The template version is invalid." })
        .min(1, "The template version is invalid.")
        .optional(),
    }),
    response: FormTemplateResponseSchema,
  }),
  templateVersions: route({
    method: "GET",
    path: "/api/forms/templates/:id/versions",
    response: FormTemplateVersionListSchema,
  }),
  templateVersion: route({
    method: "GET",
    path: "/api/forms/templates/:id/versions/:version",
    response: FormTemplateResponseSchema,
  }),
  getTemplate: route({
    method: "GET",
    path: "/api/forms/templates/:id",
    response: FormTemplateResponseSchema,
  }),
  templateActivity: route({
    method: "GET",
    path: "/api/forms/templates/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  updateTemplate: route({
    method: "PUT",
    path: "/api/forms/templates/:id",
    /** Only organization managers can publish or unpublish. */
    body: FormTemplateSaveSchema.extend({ status: TemplatePublicationSchema }),
    response: FormTemplateResponseSchema,
  }),
  /** Starts a form for a project from one of the templates turned on for it. */
  start: route({
    method: "POST",
    path: "/api/forms/templates/:id/runs",
    body: z.object({ projectId: z.string().min(1).max(200) }),
    response: z.object({ formId: z.string() }),
  }),
  listRuns: route({
    method: "GET",
    path: "/api/forms/runs",
    query: z.object({
      cursor: z.string().optional(),
      view: FormRunViewSchema.optional(),
    }),
    response: z.object({
      forms: z.array(FormSummarySchema),
      nextCursor: z.string().nullable(),
    }),
  }),
  getRun: route({
    method: "GET",
    path: "/api/forms/runs/:id",
    response: FormDetailSchema,
  }),
  runActivity: route({
    method: "GET",
    path: "/api/forms/runs/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  saveRun: route({
    method: "PATCH",
    path: "/api/forms/runs/:id",
    // The API checks each answer against the form's own questions.
    body: z.object(
      {
        /** The revision the answers were edited from. */
        expectedRevision: z
          .int({ error: formRevisionRule })
          .min(0, formRevisionRule),
        responses: z.record(
          z.string(),
          z
            .string({ error: "Invalid form responses." })
            .max(formLimits.answer, "Invalid form responses."),
          { error: "Invalid form responses." },
        ),
        /** Unchanged unless given. */
        status: z
          .enum(FormStatusSchema.options, { error: "Invalid form status." })
          .optional(),
      },
      { error: "Invalid form update." },
    ),
    response: z.object({ status: FormStatusSchema, updatedAt: z.string() }),
  }),
  createIssue: route({
    method: "POST",
    path: "/api/forms/runs/:id/issues",
    body: FormIssueCreateSchema,
    response: z.object({ issueId: z.string() }),
  }),
  updateIssue: route({
    method: "PATCH",
    path: "/api/forms/issues/:id",
    body: FormIssueUpdateSchema,
    response: z.object({
      assignedTo: z.string().nullable(),
      status: FormIssueStatusSchema,
      updatedAt: z.string(),
    }),
  }),
  /** Moves an in-progress form to the Deleted view, where it stays read-only. */
  discardRun: route({
    method: "DELETE",
    path: "/api/forms/runs/:id",
    response: z.object({ deletedAt: z.string() }),
  }),
  uploadIssueImage: route({
    method: "POST",
    path: "/api/forms/issues/:issueId/images",
    query: z.object({ filename: z.string().optional() }),
    body: "file",
    response: z.object({ image: FormIssueImageSchema }),
  }),
  issueImage: route({
    method: "GET",
    path: "/api/forms/issues/:issueId/images/:imageId",
    query: z.object({ variant: z.literal("thumbnail").optional() }),
    response: "file",
  }),
  /**
   * Answers 204 once the image is gone, or 202 when its stored file is left
   * for cleanup to remove.
   */
  deleteIssueImage: route({
    method: "DELETE",
    path: "/api/forms/issues/:issueId/images/:imageId",
    response: z.object({ cleanupPending: z.literal(true) }).optional(),
  }),
};
