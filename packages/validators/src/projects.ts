import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { PersonSchema, requiredText } from "./fields";
import { FormTemplateSchema } from "./forms";
import { route } from "./route";
import { projectLimits } from "./rules";

/**
 * A form template a project can turn on: a published global or organization
 * template, as its current version reads.
 */
const ProjectTemplateSchema = FormTemplateSchema;
export type ProjectTemplate = z.infer<typeof ProjectTemplateSchema>;

const ProjectSummarySchema = z.object({
  createdAt: z.string(),
  description: z.string(),
  /** How many form templates are turned on. */
  templateCount: z.number(),
  id: z.string(),
  /** Whether the person asking is a member of the project. */
  isMember: z.boolean(),
  memberCount: z.number(),
  name: z.string(),
  /** Counts saved edits to the name and description. */
  revision: z.number(),
  updatedAt: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

const ProjectSchema = ProjectSummarySchema.extend({
  /** The form templates turned on, as they currently read. */
  templates: z.array(ProjectTemplateSchema),
  members: z.array(PersonSchema),
});
export type Project = z.infer<typeof ProjectSchema>;

const ProjectFieldsSchema = z.object({
  description: z.string().trim().max(projectLimits.description).default(""),
  name: requiredText(projectLimits.name),
});
export type NewProject = z.input<typeof ProjectFieldsSchema>;

/** The fields to change, and the revision the edit was made from. */
const ProjectChangesSchema = z.object({
  description: z.string().trim().max(projectLimits.description).optional(),
  expectedRevision: z.number().int().nonnegative(),
  name: requiredText(projectLimits.name).optional(),
});
export type ProjectChanges = z.input<typeof ProjectChangesSchema>;

const ProjectResponseSchema = z.object({ project: ProjectSchema });

/** A deleted project, hidden from the list until it is restored. */
const DeletedProjectSchema = z.object({
  deletedAt: z.string(),
  deletedBy: PersonSchema.nullable(),
  description: z.string(),
  id: z.string(),
  name: z.string(),
});
export type DeletedProject = z.infer<typeof DeletedProjectSchema>;

export const projectsRoutes = {
  list: route({
    method: "GET",
    path: "/api/projects",
    response: z.object({
      canManage: z.boolean(),
      projects: z.array(ProjectSummarySchema),
    }),
  }),
  create: route({
    method: "POST",
    path: "/api/projects",
    body: ProjectFieldsSchema,
    response: ProjectResponseSchema,
  }),
  /** A project with the people and templates that can be added to it. */
  get: route({
    method: "GET",
    path: "/api/projects/:id",
    response: ProjectResponseSchema.extend({
      availableTemplates: z.array(ProjectTemplateSchema),
      canManage: z.boolean(),
      directory: z.array(PersonSchema),
    }),
  }),
  activity: route({
    method: "GET",
    path: "/api/projects/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  update: route({
    method: "PATCH",
    path: "/api/projects/:id",
    body: ProjectChangesSchema,
    response: ProjectResponseSchema,
  }),
  /**
   * Hides the project; its forms, members, templates, and history stay, and
   * restoring brings it back as it was.
   */
  delete: route({
    method: "DELETE",
    path: "/api/projects/:id",
    response: "empty",
  }),
  /**
   * The organization's projects, each marked with whether `templateId` is
   * turned on for it. `available` says whether the template can be turned on:
   * it must be a published template the organization can use.
   */
  templateProjects: route({
    method: "GET",
    path: "/api/projects/templates/:templateId",
    response: z.object({
      available: z.boolean(),
      canManage: z.boolean(),
      projects: z.array(
        z.object({ enabled: z.boolean(), id: z.string(), name: z.string() }),
      ),
    }),
  }),
  /** Deleted projects, most recently deleted first. */
  listDeleted: route({
    method: "GET",
    path: "/api/projects/deleted",
    response: z.object({
      canManage: z.boolean(),
      projects: z.array(DeletedProjectSchema),
    }),
  }),
  restore: route({
    method: "POST",
    path: "/api/projects/:id/restore",
    response: ProjectResponseSchema,
  }),
  addMember: route({
    method: "PUT",
    path: "/api/projects/:id/members/:userId",
    response: ProjectResponseSchema,
  }),
  removeMember: route({
    method: "DELETE",
    path: "/api/projects/:id/members/:userId",
    response: ProjectResponseSchema,
  }),
  /** Turns a form template on for the project. */
  enableTemplate: route({
    method: "PUT",
    path: "/api/projects/:id/templates/:templateId",
    response: ProjectResponseSchema,
  }),
  /** Turns a form template off for the project. */
  disableTemplate: route({
    method: "DELETE",
    path: "/api/projects/:id/templates/:templateId",
    response: ProjectResponseSchema,
  }),
};
