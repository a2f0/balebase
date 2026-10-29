import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { PersonSchema, requiredText } from "./fields";
import { route } from "./route";
import { projectLimits } from "./rules";

/** An audit form a project can turn on: a global or organization form. */
const ProjectFormSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(["global", "organization"]),
  version: z.number(),
});
export type ProjectForm = z.infer<typeof ProjectFormSchema>;

const ProjectSummarySchema = z.object({
  createdAt: z.string(),
  description: z.string(),
  /** How many audit forms are turned on. */
  formCount: z.number(),
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
  /** The audit forms turned on, as they currently read. */
  forms: z.array(ProjectFormSchema),
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
  /** A project with the people and forms that can be added to it. */
  get: route({
    method: "GET",
    path: "/api/projects/:id",
    response: ProjectResponseSchema.extend({
      availableForms: z.array(ProjectFormSchema),
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
  delete: route({
    method: "DELETE",
    path: "/api/projects/:id",
    response: "empty",
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
  /** Turns an audit form on for the project. */
  enableForm: route({
    method: "PUT",
    path: "/api/projects/:id/forms/:templateId",
    response: ProjectResponseSchema,
  }),
  /** Turns an audit form off for the project. */
  disableForm: route({
    method: "DELETE",
    path: "/api/projects/:id/forms/:templateId",
    response: ProjectResponseSchema,
  }),
};
