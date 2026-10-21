import { z } from "zod";
import { route } from "./route";

export const ContractStatusSchema = z.enum([
  "completed",
  "declined",
  "draft",
  "sent",
  "voided",
]);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

export const RecipientStatusSchema = z.enum([
  "declined",
  "pending",
  "sent",
  "signed",
  "viewed",
]);
export type RecipientStatus = z.infer<typeof RecipientStatusSchema>;

export const FieldTypeSchema = z.enum([
  "date_signed",
  "initials",
  "name",
  "signature",
  "text",
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const SigningOrderSchema = z.enum(["parallel", "sequential"]);
export type SigningOrder = z.infer<typeof SigningOrderSchema>;

/** Where a field sits on its page, as fractions of the page. */
export const FieldBoxSchema = z.object({
  height: z.number(),
  page: z.number(),
  width: z.number(),
  x: z.number(),
  y: z.number(),
});
export type FieldBox = z.infer<typeof FieldBoxSchema>;

/** The uploaded PDF a contract or template is drawn on. */
export const ContractDocumentSchema = z.object({
  filename: z.string(),
  pageCount: z.number(),
  sha256: z.string(),
  size: z.number(),
});

const ContractSummarySchema = z.object({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  dueDate: z.string().nullable(),
  id: z.string(),
  senderName: z.string().nullable(),
  sentAt: z.string().nullable(),
  signedCount: z.number(),
  signerCount: z.number(),
  status: ContractStatusSchema,
  title: z.string(),
  updatedAt: z.string(),
});
export type ContractSummary = z.infer<typeof ContractSummarySchema>;

const ContractRecipientSchema = z.object({
  declineReason: z.string().nullable(),
  declinedAt: z.string().nullable(),
  email: z.string(),
  id: z.string(),
  lastRemindedAt: z.string().nullable(),
  name: z.string(),
  notifiedAt: z.string().nullable(),
  routingOrder: z.number(),
  signedAt: z.string().nullable(),
  status: RecipientStatusSchema,
  viewedAt: z.string().nullable(),
});
export type ContractRecipient = z.infer<typeof ContractRecipientSchema>;

const ContractFieldSchema = FieldBoxSchema.extend({
  id: z.string(),
  label: z.string().nullable(),
  recipientId: z.string(),
  required: z.boolean(),
  type: FieldTypeSchema,
  value: z.string().nullable(),
});
export type ContractField = z.infer<typeof ContractFieldSchema>;

const ContractEventSchema = z.object({
  actorName: z.string().nullable(),
  createdAt: z.string(),
  detail: z.string().nullable(),
  id: z.string(),
  ip: z.string().nullable(),
  recipientId: z.string().nullable(),
  type: z.string(),
});
export type ContractEvent = z.infer<typeof ContractEventSchema>;

const ContractDetailSchema = z.object({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  document: ContractDocumentSchema,
  dueDate: z.string().nullable(),
  events: z.array(ContractEventSchema),
  fields: z.array(ContractFieldSchema),
  finalSha256: z.string().nullable(),
  id: z.string(),
  message: z.string(),
  recipients: z.array(ContractRecipientSchema),
  reminderIntervalDays: z.number().nullable(),
  sentAt: z.string().nullable(),
  sentByName: z.string().nullable(),
  signingOrder: SigningOrderSchema,
  status: ContractStatusSchema,
  /** The template version it was created from, if any. */
  template: z.object({ name: z.string(), version: z.number() }).nullable(),
  title: z.string(),
  updatedAt: z.string(),
  voidReason: z.string().nullable(),
  voidedAt: z.string().nullable(),
});
export type ContractDetail = z.infer<typeof ContractDetailSchema>;

const DraftRecipientSchema = z.object({
  email: z.string(),
  /** Identifies the signer within the draft; fields name it as theirs. */
  key: z.string(),
  name: z.string(),
  routingOrder: z.number(),
});
export type DraftRecipient = z.infer<typeof DraftRecipientSchema>;

export const DraftFieldSchema = FieldBoxSchema.extend({
  label: z.string().nullable(),
  recipientKey: z.string(),
  /** Only text fields can be optional. */
  required: z.boolean(),
  type: FieldTypeSchema,
});

const ContractDraftSchema = z.object({
  dueDate: z.string().nullable(),
  fields: z.array(DraftFieldSchema),
  message: z.string(),
  recipients: z.array(DraftRecipientSchema),
  reminderIntervalDays: z.number().nullable(),
  signingOrder: SigningOrderSchema,
  title: z.string(),
});
export type ContractDraft = z.infer<typeof ContractDraftSchema>;

/** A draft save; signers may be half filled in until the contract is sent. */
const DraftBodySchema = ContractDraftSchema.partial({
  dueDate: true,
  message: true,
  reminderIntervalDays: true,
}).extend({
  fields: z.array(DraftFieldSchema.partial({ label: true, required: true })),
  recipients: z.array(
    DraftRecipientSchema.partial({ email: true, name: true }),
  ),
});
export type ContractDraftInput = z.input<typeof DraftBodySchema>;

// Null only when the contract was deleted while the request ran.
const ChangedContractSchema = z.object({
  contract: ContractDetailSchema.nullable(),
});

export const contractsRoutes = {
  list: route({
    method: "GET",
    path: "/api/contracts",
    response: z.object({ contracts: z.array(ContractSummarySchema) }),
  }),
  upload: route({
    method: "POST",
    path: "/api/contracts",
    body: "form",
    response: ChangedContractSchema,
  }),
  get: route({
    method: "GET",
    path: "/api/contracts/:id",
    response: z.object({ contract: ContractDetailSchema }),
  }),
  document: route({
    method: "GET",
    path: "/api/contracts/:id/document",
    response: "file",
  }),
  final: route({
    method: "GET",
    path: "/api/contracts/:id/final",
    response: "file",
  }),
  saveDraft: route({
    method: "PUT",
    path: "/api/contracts/:id/draft",
    body: DraftBodySchema,
    response: ChangedContractSchema,
  }),
  send: route({
    method: "POST",
    path: "/api/contracts/:id/send",
    response: ChangedContractSchema,
  }),
  remind: route({
    method: "POST",
    path: "/api/contracts/:id/remind",
    response: ChangedContractSchema.extend({
      /** How many reminder emails were accepted for delivery. */
      reminded: z.number(),
    }),
  }),
  void: route({
    method: "POST",
    path: "/api/contracts/:id/void",
    body: z.object({ reason: z.string().optional() }),
    response: ChangedContractSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/contracts/:id",
    response: "empty",
  }),
};
