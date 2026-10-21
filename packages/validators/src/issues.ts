import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { route } from "./route";

export const IssueTargetTypeSchema = z.enum([
  "audit_run",
  "finance_transaction",
  "workspace",
]);
export type IssueTargetType = z.infer<typeof IssueTargetTypeSchema>;

const IssuePrioritySchema = z.enum(["low", "medium", "high", "critical"]);
const IssueStatusSchema = z.enum(["open", "resolved"]);

export const IssueMemberSchema = z.object({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});
export type IssueMember = z.infer<typeof IssueMemberSchema>;

export const IssueSchema = z.object({
  assignedTo: IssueMemberSchema.nullable(),
  createdAt: z.string(),
  createdBy: IssueMemberSchema,
  description: z.string(),
  id: z.string(),
  priority: IssuePrioritySchema,
  revision: z.number(),
  status: IssueStatusSchema,
  target: z.object({
    available: z.boolean(),
    id: z.string().nullable(),
    itemId: z.string().nullable(),
    label: z.string(),
    type: IssueTargetTypeSchema,
  }),
  title: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;

const IssuePageSchema = z.object({
  issues: z.array(IssueSchema),
  nextCursor: z.string().nullable(),
});
export type IssuePage = z.infer<typeof IssuePageSchema>;

const IssueListQuerySchema = z.object({
  cursor: z.string().optional(),
  q: z.string().optional(),
  status: z.enum(["all", "open", "resolved"]).optional(),
  targetId: z.string().optional(),
  type: z.enum(["all", ...IssueTargetTypeSchema.options]).optional(),
});

const IssueFieldsSchema = z.object({
  assignedTo: z.string().nullable(),
  description: z.string(),
  priority: IssuePrioritySchema,
  title: z.string(),
});
export type IssueInput = z.infer<typeof IssueFieldsSchema>;

const IssueCreateSchema = IssueFieldsSchema.partial().extend({
  target: z
    .object({
      id: z.string(),
      itemId: z.string().optional(),
      type: IssueTargetTypeSchema,
    })
    .optional(),
  title: z.string(),
});

const IssueUpdateSchema = IssueFieldsSchema.partial().extend({
  expectedRevision: z.number(),
  status: IssueStatusSchema.optional(),
});
export type IssueUpdate = z.infer<typeof IssueUpdateSchema>;

const IssueResponseSchema = z.object({ issue: IssueSchema });

export const issuesRoutes = {
  list: route({
    method: "GET",
    path: "/api/issues",
    query: IssueListQuerySchema,
    response: IssuePageSchema,
  }),
  members: route({
    method: "GET",
    path: "/api/issues/members",
    response: z.object({ members: z.array(IssueMemberSchema) }),
  }),
  get: route({
    method: "GET",
    path: "/api/issues/:id",
    response: IssueResponseSchema,
  }),
  activity: route({
    method: "GET",
    path: "/api/issues/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  create: route({
    method: "POST",
    path: "/api/issues",
    body: IssueCreateSchema,
    response: z.object({ issueId: z.string() }),
  }),
  update: route({
    method: "PATCH",
    path: "/api/issues/:id",
    body: IssueUpdateSchema,
    response: IssueResponseSchema,
  }),
};
