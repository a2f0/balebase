import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import {
  type FormInput,
  optionalText,
  PersonSchema,
  requiredText,
} from "./fields";
import { route } from "./route";
import { issueLimits, issuePriorities } from "./rules";

const IssueTargetTypeSchema = z.enum([
  "audit_run",
  "finance_transaction",
  "workspace",
]);
export type IssueTargetType = z.infer<typeof IssueTargetTypeSchema>;

const IssuePrioritySchema = z.enum(issuePriorities);
const IssueStatusSchema = z.enum(["open", "resolved"]);

export type IssueMember = z.infer<typeof PersonSchema>;

export const IssueSchema = z.object({
  assignedTo: PersonSchema.nullable(),
  createdAt: z.string(),
  createdBy: PersonSchema,
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
  /** Matches part of the title. */
  q: z.string().trim().max(200).optional(),
  status: z.enum(["all", "open", "resolved"]).default("open"),
  targetId: z.string().min(1).max(200).optional(),
  type: z.enum(["all", ...IssueTargetTypeSchema.options]).default("all"),
});

/**
 * What people write on every issue, wherever it is raised. A blank or null
 * assignee leaves the issue unassigned.
 */
const IssueFieldsSchema = z.object({
  assignedTo: optionalText(z.string().trim().max(200)),
  description: z.string().trim().max(issueLimits.description),
  priority: IssuePrioritySchema,
  title: requiredText(issueLimits.title),
});
export type IssueInput = FormInput<typeof IssueFieldsSchema>;

/** A new issue: unassigned, medium, and without details unless given. */
export const NewIssueSchema = IssueFieldsSchema.extend({
  description: IssueFieldsSchema.shape.description.default(""),
  priority: IssuePrioritySchema.default("medium"),
});

const targetId = z.string().trim().min(1).max(200);

const IssueCreateSchema = NewIssueSchema.extend({
  /** A new issue is always open. */
  status: z.literal("open").optional(),
  /** The record the issue is about; a workspace issue when left out. */
  target: z
    .discriminatedUnion("type", [
      z.object({
        id: z.null().optional(),
        itemId: z.null().optional(),
        type: z.literal("workspace"),
      }),
      z.object({
        id: targetId,
        itemId: z.null().optional(),
        type: z.literal("finance_transaction"),
      }),
      z.object({
        id: targetId,
        /** The audit checklist item the issue is about. */
        itemId: z.string().trim().min(1).max(100),
        type: z.literal("audit_run"),
      }),
    ])
    .optional(),
});

export type NewIssueTarget = NonNullable<
  z.input<typeof IssueCreateSchema>["target"]
>;

const revisionRule = "A valid issue revision is required.";

// The revision comes first so its message wins over the other fields'.
const IssueUpdateSchema = z.object(
  {
    expectedRevision: z.int({ error: revisionRule }).min(0, revisionRule),
    ...IssueFieldsSchema.partial().shape,
    status: IssueStatusSchema.optional(),
  },
  { error: revisionRule },
);
export type IssueUpdate = z.input<typeof IssueUpdateSchema>;

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
    response: z.object({ members: z.array(PersonSchema) }),
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
