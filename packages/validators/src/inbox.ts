import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { lineName, RecordIdSchema } from "./fields";
import { route } from "./route";

/** An email linked to a folder, transaction, or item, as the target lists it. */
export const LinkedEmailSchema = z.object({
  attachmentCount: z.number(),
  from: z.string(),
  id: z.string(),
  linkId: z.string(),
  receivedAt: z.string(),
  status: z.enum(["inbox", "archived"]),
  subject: z.string().nullable(),
});
export type LinkedEmail = z.infer<typeof LinkedEmailSchema>;

const InboxFolderSchema = z.enum(["inbox", "trash", "archived"]);
export type InboxFolder = z.infer<typeof InboxFolderSchema>;

/** Which folder to read; the Inbox when absent. */
const InboxFolderQuerySchema = z.object({
  folder: InboxFolderSchema.optional(),
});

const InboundEmailSummarySchema = z.object({
  attachmentCount: z.number(),
  deletedAt: z.string().nullable(),
  deletedByEmail: z.string().nullable(),
  deletedByName: z.string().nullable(),
  deletedByUserId: z.string().nullable(),
  from: z.string(),
  id: z.string(),
  linkCount: z.number(),
  rawSize: z.number(),
  receivedAt: z.string(),
  status: InboxFolderSchema,
  subject: z.string().nullable(),
  to: z.string(),
});
export type InboundEmailSummary = z.infer<typeof InboundEmailSummarySchema>;

const EmailLinkTargetTypeSchema = z.enum([
  "equipment",
  "finance_transaction",
  "library_folder",
]);

/** A record an email is linked to, with what its chip shows. */
const InboundEmailLinkSchema = z.discriminatedUnion("targetType", [
  z.object({
    equipment: z.object({
      make: z.string(),
      model: z.string(),
      serialNumber: z.string().nullable(),
      type: z.string(),
    }),
    id: z.string(),
    targetId: z.string(),
    targetType: z.literal("equipment"),
  }),
  z.object({
    folder: z.object({ name: z.string() }),
    id: z.string(),
    targetId: z.string(),
    targetType: z.literal("library_folder"),
  }),
  z.object({
    id: z.string(),
    targetId: z.string(),
    targetType: z.literal("finance_transaction"),
    transaction: z.object({
      amount: z.number(),
      currencyCode: z.string().nullable(),
      date: z.string(),
      merchantName: z.string().nullable(),
      name: z.string(),
    }),
  }),
]);
export type InboundEmailLink = z.infer<typeof InboundEmailLinkSchema>;

const InboundEmailLinkTargetSchema = z.object({
  targetId: RecordIdSchema,
  targetType: EmailLinkTargetTypeSchema,
});
export type InboundEmailLinkTarget = z.infer<
  typeof InboundEmailLinkTargetSchema
>;

const InboundEmailAttachmentSchema = z.object({
  contentType: z.string(),
  filename: z.string(),
  id: z.string(),
  size: z.number(),
});
export type InboundEmailAttachment = z.infer<
  typeof InboundEmailAttachmentSchema
>;

const InboundEmailDetailSchema = InboundEmailSummarySchema.extend({
  attachments: z.array(InboundEmailAttachmentSchema),
  html: z.string().nullable(),
  links: z.array(InboundEmailLinkSchema),
  text: z.string().nullable(),
});
export type InboundEmailDetail = z.infer<typeof InboundEmailDetailSchema>;

const EmailIdSchema = z.object({ emailId: z.string() });

const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(230)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Enter a domain such as example.com.",
  );

const MailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  connected: z.boolean(),
});
export type Mailbox = z.infer<typeof MailboxSchema>;

const DomainClaimSchema = z.object({
  id: z.string(),
  domain: z.string(),
  recordName: z.string(),
  recordValue: z.string(),
  status: z.enum(["pending", "verified"]),
});
export type DomainClaim = z.infer<typeof DomainClaimSchema>;

export const inboxRoutes = {
  routing: route({
    method: "GET",
    path: "/api/inbox/routing",
    response: z.object({
      domains: z.array(DomainClaimSchema),
      mailboxes: z.array(
        MailboxSchema.extend({ forwardingAddress: z.string() }),
      ),
    }),
  }),
  claim: route({
    method: "POST",
    path: "/api/inbox/routing/domains",
    body: z.object({ domain: DomainSchema }),
    response: DomainClaimSchema,
  }),
  verify: route({
    method: "POST",
    path: "/api/inbox/routing/domains/:id/verify",
    response: DomainClaimSchema,
  }),
  release: route({
    method: "DELETE",
    path: "/api/inbox/routing/domains/:id",
    response: "empty",
  }),
  bind: route({
    method: "POST",
    path: "/api/inbox/routing/mailboxes",
    body: z.object({
      name: lineName(80, "Enter an inbox name of up to 80 characters."),
      address: z.email().trim().toLowerCase().max(254),
    }),
    response: z.object({ id: z.string(), forwardingAddress: z.string() }),
  }),
  disconnect: route({
    method: "DELETE",
    path: "/api/inbox/routing/mailboxes/:id",
    response: "empty",
  }),
  list: route({
    method: "GET",
    path: "/api/inbox",
    query: InboxFolderQuerySchema.extend({
      folder: InboxFolderSchema.or(z.literal("")).optional(),
      mailbox: RecordIdSchema.optional(),
      email: RecordIdSchema.optional(),
    }),
    response: z.object({
      /** The address that delivers mail to this organization's inbox. */
      address: z.string(),
      emails: z.array(InboundEmailSummarySchema),
      mailboxId: z.string().nullable(),
      mailboxes: z.array(MailboxSchema),
    }),
  }),
  get: route({
    method: "GET",
    path: "/api/inbox/:id",
    query: InboxFolderQuerySchema,
    response: z.object({ email: InboundEmailDetailSchema }),
  }),
  activity: route({
    method: "GET",
    path: "/api/inbox/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  link: route({
    method: "POST",
    path: "/api/inbox/:id/links",
    body: InboundEmailLinkTargetSchema,
    response: z.object({ link: InboundEmailLinkSchema }),
  }),
  unlink: route({
    method: "DELETE",
    path: "/api/inbox/:id/links/:linkId",
    response: "empty",
  }),
  attachment: route({
    method: "GET",
    path: "/api/inbox/:emailId/attachments/:attachmentId",
    query: InboxFolderQuerySchema,
    response: "file",
  }),
  delete: route({
    method: "DELETE",
    path: "/api/inbox/:id",
    response: z.object({
      deletedAt: z.string(),
      deletedByUserId: z.string(),
      emailId: z.string(),
    }),
  }),
  archive: route({
    method: "POST",
    path: "/api/inbox/:id/archive",
    response: EmailIdSchema,
  }),
  restore: route({
    method: "POST",
    path: "/api/inbox/:id/restore",
    response: EmailIdSchema,
  }),
};
