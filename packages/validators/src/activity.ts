import { z } from "zod";
import { route } from "./route";

/** The API key behind an event, and whether MCP or REST called it. */
const ActivityApiKeySchema = z.object({
  channel: z.enum(["mcp", "rest"]),
  /** Null only once the key itself is removed; its name is kept. */
  id: z.string().nullable(),
  name: z.string(),
});

export const ActivityActorSchema = z.object({
  /** Set when the person acted through an API key. */
  apiKey: ActivityApiKeySchema.nullish(),
  email: z.string(),
  id: z.string(),
  name: z.string(),
});
export type ActivityActor = z.infer<typeof ActivityActorSchema>;

const detail = z.unknown().optional();

/** What changed. Each action records its own fields; these are the common ones. */
const ActivityDetailsSchema = z
  .object({
    access: detail,
    after: detail,
    afterEmail: detail,
    afterName: detail,
    assignedTo: detail,
    assigneeEmail: detail,
    assigneeName: detail,
    before: detail,
    beforeEmail: detail,
    beforeName: detail,
    changes: detail,
    description: detail,
    filename: detail,
    make: detail,
    model: detail,
    prefix: detail,
    priority: detail,
    prompt: detail,
    purchaseDate: detail,
    responseType: detail,
    serialNumber: detail,
    title: detail,
    type: detail,
    userEmail: detail,
    userId: detail,
    userName: detail,
    version: detail,
  })
  .catchall(z.unknown());

export const ActivityEventSchema = z.object({
  action: z.string(),
  actor: ActivityActorSchema,
  details: ActivityDetailsSchema,
  historical: z.boolean(),
  id: z.number(),
  occurredAt: z.string(),
  root: z.object({ id: z.string(), label: z.string(), type: z.string() }),
  subject: z.object({ id: z.string(), type: z.string() }),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityPageSchema = z.object({
  events: z.array(ActivityEventSchema),
  nextCursor: z.string().nullable(),
});
export type ActivityPage = z.infer<typeof ActivityPageSchema>;

/** Every activity history pages with the last event's cursor. */
export const ActivityQuerySchema = z.object({ cursor: z.string().optional() });

export const ActivityResourceTypeSchema = z.enum([
  "audit_run",
  "audit_template",
  "equipment",
  "organization_member",
  "api_key",
  "finance_transaction",
  "issue",
]);
export type ActivityResourceType = z.infer<typeof ActivityResourceTypeSchema>;

export const activityRoutes = {
  list: route({
    method: "GET",
    path: "/api/activity",
    query: ActivityQuerySchema.extend({
      resourceType: ActivityResourceTypeSchema.optional(),
    }),
    response: ActivityPageSchema,
  }),
};
