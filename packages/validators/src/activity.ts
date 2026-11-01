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

/**
 * Who made a change: a person (`user`), Balebase's own maintenance
 * (`system`), or a provider such as Stripe, Plaid, or Checkr (`provider`).
 */
const ActivityActorTypeSchema = z.enum(["user", "system", "provider"]);
export type ActivityActorType = z.infer<typeof ActivityActorTypeSchema>;

/**
 * The actor of an event. Only a person has an ID and email; a system or
 * provider actor names its `source` (the maintenance job's ID, or the
 * provider) and has an empty email. `name` is always a display label.
 */
export const ActivityActorSchema = PersonSchema.extend({
  id: z.string().nullable(),
  /** The maintenance job or provider behind a system or provider change. */
  source: z.string().nullable(),
  type: ActivityActorTypeSchema,
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
    apiKeys: detail,
    assignedTo: detail,
    assigneeEmail: detail,
    assigneeName: detail,
    attachmentCount: detail,
    before: detail,
    beforeEmail: detail,
    beforeName: detail,
    canceledInvitations: detail,
    canceledSubscriptionIds: detail,
    capabilities: detail,
    changes: detail,
    checkrReport: detail,
    clientCompletedAt: detail,
    clientStartedAt: detail,
    completedBefore: detail,
    consentsRemoved: detail,
    copiedFrom: detail,
    count: detail,
    declinedAt: detail,
    deletedAt: detail,
    deletedBy: detail,
    deletedByEmail: detail,
    deletedByName: detail,
    description: detail,
    dueDate: detail,
    duns: detail,
    ein: detail,
    email: detail,
    emailLinkCount: detail,
    errorCodeBefore: detail,
    equipmentLinkCount: detail,
    fieldCount: detail,
    fileCount: detail,
    filename: detail,
    folderId: detail,
    folderLinkCount: detail,
    folderName: detail,
    from: detail,
    fromFolderId: detail,
    fromFolderName: detail,
    fromStatus: detail,
    institutionName: detail,
    inviterEmail: detail,
    inviterName: detail,
    issueCount: detail,
    kind: detail,
    make: detail,
    members: detail,
    model: detail,
    name: detail,
    names: detail,
    openIssueCount: detail,
    ownerEmail: detail,
    ownerName: detail,
    pageCount: detail,
    personEmail: detail,
    personName: detail,
    portalSessionId: detail,
    prefix: detail,
    previousName: detail,
    previousReportId: detail,
    previousStatus: detail,
    priority: detail,
    prompt: detail,
    purchaseDate: detail,
    quantity: detail,
    reason: detail,
    removedCapabilities: detail,
    removedMembers: detail,
    renamedFrom: detail,
    replaced: detail,
    requestedAt: detail,
    requestedBy: detail,
    requestedByEmail: detail,
    requestedByName: detail,
    rerequest: detail,
    responseType: detail,
    retentionDays: detail,
    revision: detail,
    /** API keys an access change revoked, as `{ id, name }`. */
    revokedApiKeys: detail,
    role: detail,
    roleCount: detail,
    seatQuantity: detail,
    serialNumber: detail,
    signedCount: detail,
    signerCount: detail,
    signingOrder: detail,
    sourceVersion: detail,
    status: detail,
    statusBefore: detail,
    subject: detail,
    subscriptionId: detail,
    templateName: detail,
    templateVersion: detail,
    title: detail,
    toFolderId: detail,
    toFolderName: detail,
    transactionCount: detail,
    type: detail,
    uploadedBySubject: detail,
    userEmail: detail,
    userId: detail,
    userName: detail,
    version: detail,
    versionCount: detail,
    via: detail,
    workCity: detail,
    workState: detail,
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
  "organization",
  "organization_member",
  "organization_invitation",
  "organization_group",
  "api_key",
  "finance_transaction",
  "finance_connection",
  "finance_category",
  "organization_billing",
  "issue",
  "project",
  "library_file",
  "library_folder",
  "inbound_email",
  "business",
  "contract",
  "contract_template",
  "employee_requirement",
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
