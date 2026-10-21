import { z } from "zod";
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
  targetId: z.string(),
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

export const inboxRoutes = {
  list: route({
    method: "GET",
    path: "/api/inbox",
    query: InboxFolderQuerySchema,
    response: z.object({
      /** The address that delivers mail to this organization's inbox. */
      address: z.string(),
      emails: z.array(InboundEmailSummarySchema),
    }),
  }),
  get: route({
    method: "GET",
    path: "/api/inbox/:id",
    query: InboxFolderQuerySchema,
    response: z.object({ email: InboundEmailDetailSchema }),
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
