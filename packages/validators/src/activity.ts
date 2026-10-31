import { z } from "zod";
import { PersonSchema } from "./fields";
import { route } from "./route";

/** The API key behind an event, and whether MCP or REST called it. */
const ActivityApiKeySchema = z.object({
  channel: z.enum(["mcp", "rest"]),
  /** Null only once the key itself is removed; its name is kept. */
  id: z.string().nullable(),
  name: z.string(),
});

export const ActivityActorSchema = PersonSchema.extend({
  /** Set when the person acted through an API key. */
  apiKey: ActivityApiKeySchema.nullish(),
});
export type ActivityActor = z.infer<typeof ActivityActorSchema>;

const detail = z.unknown().optional();

/** What changed. Each action records its own fields; these are the common ones. */
const ActivityDetailsSchema = z
  .object({
    access: detail,
    accountCount: detail,
    addedCapabilities: detail,
    addedMembers: detail,
    after: detail,
    afterEmail: detail,
    afterName: detail,
    annotationCount: detail,
    assignedTo: detail,
    assigneeEmail: detail,
    assigneeName: detail,
    before: detail,
    beforeEmail: detail,
    beforeName: detail,
    capabilities: detail,
    changes: detail,
    clientCompletedAt: detail,
    clientStartedAt: detail,
    description: detail,
    filename: detail,
    institutionName: detail,
    make: detail,
    members: detail,
    model: detail,
    name: detail,
    names: detail,
    prefix: detail,
    priority: detail,
    prompt: detail,
    purchaseDate: detail,
    quantity: detail,
    removedCapabilities: detail,
    removedMembers: detail,
    renamedFrom: detail,
    responseType: detail,
    serialNumber: detail,
    title: detail,
    transactionCount: detail,
    type: detail,
    userEmail: detail,
    userId: detail,
    userName: detail,
    version: detail,
  })
  .catchall(z.unknown());

const ActivityEventSchema = z.object({
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

const ActivityResourceTypeSchema = z.enum([
  "audit_run",
  "audit_template",
  "equipment",
  "organization_member",
  "organization_group",
  "api_key",
  "finance_transaction",
  "finance_connection",
  "finance_category",
  "organization_billing",
  "issue",
  "project",
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
