import { z } from "zod";
import {
  ContractDocumentSchema,
  DraftFieldSchema,
  SigningOrderSchema,
} from "./contracts";
import { route } from "./route";

/** Who signs, without naming a person; each use maps it to someone. */
const TemplateRoleSchema = z.object({
  key: z.string(),
  label: z.string(),
  routingOrder: z.number(),
});

/** A field as a template keeps it, owned by a role rather than a signer. */
const TemplateFieldSchema = DraftFieldSchema.omit({
  recipientKey: true,
}).extend({ roleKey: z.string() });

const TemplateDefinitionSchema = z.object({
  fields: z.array(TemplateFieldSchema),
  message: z.string(),
  reminderIntervalDays: z.number().nullable(),
  roles: z.array(TemplateRoleSchema),
  signingOrder: SigningOrderSchema,
});
export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

const ContractTemplateSummarySchema = z.object({
  currentVersion: z.number(),
  description: z.string(),
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
});
export type ContractTemplateSummary = z.infer<
  typeof ContractTemplateSummarySchema
>;

/** One version of a template; versions never change once saved. */
const ContractTemplateSchema = z.object({
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  /** The family's latest version, which a save must build on. */
  currentVersion: z.number(),
  definition: TemplateDefinitionSchema,
  description: z.string(),
  document: ContractDocumentSchema,
  /** The template family's id, shared by all of its versions. */
  id: z.string(),
  name: z.string(),
  version: z.number(),
});
export type ContractTemplate = z.infer<typeof ContractTemplateSchema>;

const TemplateVersionSchema = z.object({
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  name: z.string(),
  version: z.number(),
});
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;

/** Picks a version by number; the latest without one. */
const VersionQuerySchema = z.object({ version: z.string().optional() });

const TemplateVersionBodySchema = z.object({
  definition: TemplateDefinitionSchema.partial({
    message: true,
    reminderIntervalDays: true,
  }).extend({
    fields: z.array(
      TemplateFieldSchema.partial({ label: true, required: true }),
    ),
  }),
  description: z.string(),
  /** The latest version the save builds on; a newer one refuses it. */
  expectedCurrentVersion: z.number(),
  name: z.string(),
  /** The version whose document the new version keeps. */
  sourceVersion: z.number(),
});
export type TemplateVersionInput = Pick<
  z.input<typeof TemplateVersionBodySchema>,
  "definition" | "description" | "name"
>;

const TemplateContractBodySchema = z.object({
  dueDate: z.string().nullish(),
  /** One person for each of the version's roles. */
  recipients: z.array(
    z.object({ email: z.string(), name: z.string(), roleKey: z.string() }),
  ),
  /** The template's name when left out. */
  title: z.string().optional(),
  version: z.number(),
});
export type TemplateContractInput = z.input<typeof TemplateContractBodySchema>;

// Null only when the template was deleted while the request ran.
const ChangedTemplateSchema = z.object({
  template: ContractTemplateSchema.nullable(),
});

export const contractTemplatesRoutes = {
  list: route({
    method: "GET",
    path: "/api/contracts/templates",
    response: z.object({ templates: z.array(ContractTemplateSummarySchema) }),
  }),
  upload: route({
    method: "POST",
    path: "/api/contracts/templates",
    body: "form",
    response: ChangedTemplateSchema,
  }),
  get: route({
    method: "GET",
    path: "/api/contracts/templates/:id",
    query: VersionQuerySchema,
    response: z.object({ template: ContractTemplateSchema }),
  }),
  versions: route({
    method: "GET",
    path: "/api/contracts/templates/:id/versions",
    response: z.object({ versions: z.array(TemplateVersionSchema) }),
  }),
  document: route({
    method: "GET",
    path: "/api/contracts/templates/:id/document",
    query: VersionQuerySchema,
    response: "file",
  }),
  saveVersion: route({
    method: "POST",
    path: "/api/contracts/templates/:id/versions",
    body: TemplateVersionBodySchema,
    response: ChangedTemplateSchema,
  }),
  createContract: route({
    method: "POST",
    path: "/api/contracts/templates/:id/contracts",
    body: TemplateContractBodySchema,
    response: z.object({ contractId: z.string() }),
  }),
  delete: route({
    method: "DELETE",
    path: "/api/contracts/templates/:id",
    response: "empty",
  }),
};
