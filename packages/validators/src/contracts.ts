import { z } from "zod";
import { calendarDate, optionalText, requiredText } from "./fields";
import { route } from "./route";
import { contractLimits } from "./rules";

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

const signerRule = "A signer is invalid.";
const routingRule = "A signer's signing order is invalid.";
const edgeRule = "A field extends past the edge of its page.";
const ownerRule = "Every field must belong to a signer.";

/** The signing step, for sequential contracts. */
export const RoutingOrderSchema = z
  .int({ error: routingRule })
  .min(1, routingRule)
  .max(contractLimits.signers, routingRule);

/** What identifies a signer, or a template's role, within one request. */
export const SignerKeySchema = z
  .string({ error: signerRule })
  .min(1, signerRule)
  .max(100, signerRule);

const fraction = z.number({ error: edgeRule }).min(0, edgeRule);

const pageRule = "A field is on a page the document doesn't have.";
const labelRule = "A field label is invalid.";

/** A field's type, page, box, and label, before it is given an owner. */
export const FieldPlacementSchema = z.object(
  {
    type: z.enum(FieldTypeSchema.options, {
      error: "A field type is invalid.",
    }),
    page: z.int({ error: pageRule }).min(1, pageRule),
    x: fraction.lt(1, edgeRule),
    y: fraction.lt(1, edgeRule),
    width: z.number({ error: edgeRule }).gt(0, edgeRule),
    height: z.number({ error: edgeRule }).gt(0, edgeRule),
    label: z
      .string({ error: labelRule })
      .max(contractLimits.fieldLabel, labelRule)
      .nullish()
      .transform((label) => label?.trim() || null),
    required: z.boolean().optional(),
  },
  { error: "A field is invalid." },
);

/**
 * A placed field with its owner. Its box, in fractions of the page, stays
 * within the page; only text fields can be optional.
 */
export function placedField<
  Field extends z.ZodType<z.output<typeof FieldPlacementSchema>>,
>(field: Field) {
  return field
    .refine(
      // A little slack for boxes dragged flush against the edge.
      (placed) =>
        placed.x + placed.width <= 1.0001 && placed.y + placed.height <= 1.0001,
      edgeRule,
    )
    .transform((placed) => ({
      ...placed,
      required: placed.type === "text" ? placed.required !== false : true,
    }));
}

const signersRule = `Add up to ${contractLimits.signers} signers.`;
const fieldsRule = `Place up to ${contractLimits.fields} fields.`;
const reminderRule = `Reminders can repeat every 1 to ${contractLimits.reminderDays} days.`;

/** What every contract draft and template says about how it is signed. */
export const DraftDetailsSchema = z.object({
  message: z
    .string({ error: "Keep the message to 2,000 characters." })
    .trim()
    .max(contractLimits.message, "Keep the message to 2,000 characters.")
    .nullish()
    .transform((message) => message ?? ""),
  reminderIntervalDays: z
    .int({ error: reminderRule })
    .min(1, reminderRule)
    .max(contractLimits.reminderDays, reminderRule)
    .nullish()
    .transform((days) => days ?? null),
  signingOrder: z.enum(SigningOrderSchema.options, {
    error: "Choose whether signers sign in any order or one after another.",
  }),
});

/** Signers or roles, up to the limit; `missing` is for anything else. */
export function signerList<Item extends z.ZodType>(
  item: Item,
  missing = signersRule,
) {
  return z
    .array(item, { error: missing })
    .max(contractLimits.signers, signersRule);
}

/** Placed fields, up to the limit; `missing` is for anything else. */
export function fieldList<Item extends z.ZodType>(
  item: Item,
  missing = fieldsRule,
) {
  return z
    .array(item, { error: missing })
    .max(contractLimits.fields, fieldsRule);
}

export const ContractTitleSchema = requiredText(
  contractLimits.title,
  "Give the contract a title of up to 200 characters.",
);

/**
 * A draft save. Signers may be half filled in while the draft is edited;
 * sending requires a name and a valid email for each.
 */
const DraftBodySchema = z
  .object(
    {
      title: ContractTitleSchema,
      ...DraftDetailsSchema.shape,
      dueDate: optionalText(
        calendarDate("The due date is invalid."),
        "The due date is invalid.",
      ).transform((date) => date ?? null),
      recipients: signerList(
        z.object(
          {
            key: SignerKeySchema,
            name: z
              .string({ error: signerRule })
              .trim()
              .max(
                contractLimits.signerName,
                "Signer names can be up to 120 characters.",
              )
              .nullish()
              .transform((name) => name ?? ""),
            email: z
              .string({ error: signerRule })
              .trim()
              .max(
                contractLimits.signerEmail,
                "Signer emails can be up to 254 characters.",
              )
              .nullish()
              .transform((email) => email ?? ""),
            routingOrder: RoutingOrderSchema,
          },
          { error: signerRule },
        ),
      ),
      fields: fieldList(
        placedField(
          FieldPlacementSchema.extend({
            recipientKey: z.string({ error: ownerRule }),
          }),
        ),
      ),
    },
    { error: "The contract draft is invalid." },
  )
  .superRefine((draft, context) => {
    const keys = new Set<string>();
    const emails = new Set<string>();
    for (const { email, key } of draft.recipients) {
      if (keys.has(key))
        return void context.addIssue("Each signer needs a unique key.");
      keys.add(key);
      if (email && emails.has(email.toLowerCase()))
        return void context.addIssue(`${email} is listed more than once.`);
      emails.add(email.toLowerCase());
    }
    if (draft.fields.some(({ recipientKey }) => !keys.has(recipientKey)))
      context.addIssue(ownerRule);
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
    // A longer reason is cut to 500 characters rather than refused.
    body: z.object({
      reason: z
        .string()
        .optional()
        .transform((reason) => (reason ?? "").trim().slice(0, 500)),
    }),
    response: ChangedContractSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/contracts/:id",
    response: "empty",
  }),
};
