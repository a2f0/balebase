import { z } from "zod";
import {
  ContractStatusSchema,
  FieldBoxSchema,
  FieldTypeSchema,
  ReasonSchema,
  RecipientStatusSchema,
} from "./contracts";
import { route } from "./route";
import { contractLimits } from "./rules";

/** A field the signer fills; other signers' fields are left out. */
const SigningFieldSchema = FieldBoxSchema.extend({
  id: z.string(),
  label: z.string().nullable(),
  required: z.boolean(),
  type: FieldTypeSchema,
});
export type SigningField = z.infer<typeof SigningFieldSchema>;

/** What a signer's link opens: the contract, and their part in it. */
const SigningViewSchema = z.object({
  /** Whether it is the signer's turn and the contract is still out. */
  canSign: z.boolean(),
  contract: z.object({
    completedAt: z.string().nullable(),
    documentFilename: z.string(),
    dueDate: z.string().nullable(),
    message: z.string(),
    organizationName: z.string(),
    pageCount: z.number(),
    senderName: z.string().nullable(),
    status: ContractStatusSchema,
    title: z.string(),
  }),
  fields: z.array(SigningFieldSchema),
  recipient: z.object({
    email: z.string(),
    name: z.string(),
    signedAt: z.string().nullable(),
    status: RecipientStatusSchema,
  }),
});
export type SigningView = z.infer<typeof SigningViewSchema>;

const consentRule = "Agree to use electronic records and signatures to sign.";
const fieldValueRule = "A field's text is too long.";

/**
 * A signature. Which images and values it needs depends on the signer's
 * fields, so the API checks those.
 */
const SignatureSchema = z.object({
  /** Agreement to sign electronically. */
  consent: z
    .boolean({ error: consentRule })
    .refine((consent) => consent, consentRule),
  /** Adopted initials as a PNG data URL, when the signer has initials fields. */
  initials: z.string().optional(),
  /** The adopted signature as a PNG data URL. */
  signature: z.string().optional(),
  /** Text field values by field id, trimmed. */
  values: z
    .record(
      z.string(),
      z.string().trim().max(contractLimits.fieldValue, fieldValueRule),
    )
    .optional(),
});
export type Signature = z.infer<typeof SignatureSchema>;

export const signingRoutes = {
  get: route({
    method: "GET",
    credentials: "omit",
    path: "/api/signing/:token",
    response: SigningViewSchema,
  }),
  document: route({
    method: "GET",
    credentials: "omit",
    path: "/api/signing/:token/document",
    response: "file",
  }),
  final: route({
    method: "GET",
    credentials: "omit",
    path: "/api/signing/:token/final",
    response: "file",
  }),
  sign: route({
    method: "POST",
    credentials: "omit",
    path: "/api/signing/:token/sign",
    body: SignatureSchema,
    response: z.object({
      /** Whether this was the last signature, completing the contract. */
      completed: z.boolean(),
      status: z.literal("signed"),
    }),
  }),
  decline: route({
    method: "POST",
    credentials: "omit",
    path: "/api/signing/:token/decline",
    body: ReasonSchema,
    response: z.object({ status: z.literal("declined") }),
  }),
};
