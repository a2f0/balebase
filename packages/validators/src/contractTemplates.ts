import { z } from "zod";
import {
  ContractDocumentSchema,
  ContractTitleSchema,
  DraftDetailsSchema,
  DraftFieldSchema,
  FieldPlacementSchema,
  fieldList,
  placedField,
  RoutingOrderSchema,
  SignerKeySchema,
  SigningOrderSchema,
  signerList,
} from "./contracts";
import { route } from "./route";
import { contractLimits } from "./rules";

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

const versionRule = "Choose a template version.";
const VersionNumberSchema = z.int({ error: versionRule }).min(1, versionRule);

/**
 * A template's next version. Roles stand in for signers, so they follow the
 * same rules, and every role needs its own label.
 */
const TemplateVersionBodySchema = z.object(
  {
    /** The latest version the save builds on; a newer one refuses it. */
    expectedCurrentVersion: VersionNumberSchema,
    /** The version whose document the new version keeps. */
    sourceVersion: VersionNumberSchema,
    name: ContractTitleSchema,
    description: z
      .string({ error: "Keep the description to 2,000 characters." })
      .max(
        contractLimits.description,
        "Keep the description to 2,000 characters.",
      )
      .trim(),
    definition: z
      .object(
        {
          ...DraftDetailsSchema.shape,
          roles: signerList(
            z.object(
              {
                key: SignerKeySchema,
                label: z
                  .string({ error: "Give every signer role a label." })
                  .trim()
                  .min(1, "Give every signer role a label.")
                  .max(
                    contractLimits.signerName,
                    "Signer names can be up to 120 characters.",
                  ),
                routingOrder: RoutingOrderSchema,
              },
              { error: "A signer is invalid." },
            ),
            "Add at least one signer role.",
          ).min(1, "Add at least one signer role."),
          fields: fieldList(
            placedField(
              FieldPlacementSchema.extend({
                roleKey: z.string({
                  error: "Every field must belong to a signer.",
                }),
              }),
            ),
            "The template fields are invalid.",
          ),
        },
        { error: "The template definition is invalid." },
      )
      .superRefine((definition, context) => {
        const keys = new Set(definition.roles.map(({ key }) => key));
        const labels = new Set(
          definition.roles.map(({ label }) => label.toLowerCase()),
        );
        if (keys.size !== definition.roles.length)
          context.addIssue("Each signer needs a unique key.");
        else if (labels.size !== definition.roles.length)
          context.addIssue("Give each signer role a different label.");
        else if (definition.fields.some(({ roleKey }) => !keys.has(roleKey)))
          context.addIssue("Every field must belong to a signer.");
      }),
  },
  { error: "The template is invalid." },
);
export type TemplateVersionInput = Pick<
  z.input<typeof TemplateVersionBodySchema>,
  "definition" | "description" | "name"
>;

/**
 * A contract from a template version. The API maps each person to one of
 * that version's roles and checks the result as a draft.
 */
const TemplateContractBodySchema = z.object(
  {
    version: VersionNumberSchema,
    dueDate: z.string({ error: "The due date is invalid." }).nullish(),
    /** One person for each of the version's roles. */
    recipients: z.array(
      z.object(
        {
          email: z.string({ error: "A signer is invalid." }).default(""),
          name: z.string({ error: "A signer is invalid." }).default(""),
          roleKey: z.string({ error: "Map every signer role exactly once." }),
        },
        { error: "A signer is invalid." },
      ),
      { error: "Map every signer role to a person." },
    ),
    /** The template's name when left out. */
    title: z
      .string({ error: "Give the contract a title of up to 200 characters." })
      .nullish(),
  },
  { error: versionRule },
);
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
