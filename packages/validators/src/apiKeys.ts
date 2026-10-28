import { z } from "zod";
import { route } from "./route";
import {
  apiKeyAccessLevels,
  apiKeyExpirationDays,
  apiKeyNameMaxLength,
} from "./rules";

const ApiKeyAccessSchema = z.enum(apiKeyAccessLevels, {
  error: 'Access must be "read" or "write".',
});
export type ApiKeyAccess = z.infer<typeof ApiKeyAccessSchema>;

/** Days until a new key expires, or null for a key that never does. */
const ApiKeyExpirationSchema = z
  .literal(apiKeyExpirationDays, {
    error: `Expiration must be ${apiKeyExpirationDays.join(", ")} days, or null for no expiration.`,
  })
  .nullable();
export type ApiKeyExpiration = z.infer<typeof ApiKeyExpirationSchema>;

const nameRule = `Name the API key with 1 to ${apiKeyNameMaxLength} characters.`;

const ApiKeyPersonSchema = z.object({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});

const ApiKeySchema = z.object({
  access: ApiKeyAccessSchema,
  createdAt: z.string(),
  createdBy: ApiKeyPersonSchema,
  expiresAt: z.string().nullable(),
  id: z.string(),
  lastUsedAt: z.string().nullable(),
  name: z.string(),
  /** The token's first characters, enough to recognize it. */
  prefix: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: ApiKeyPersonSchema.nullable(),
  /** `inactive` keys belong to someone who no longer manages the organization. */
  status: z.enum(["active", "expired", "inactive", "revoked"]),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

// Fields in the order their messages should take precedence.
const ApiKeyInputSchema = z.object(
  {
    name: z
      .string({ error: nameRule })
      .trim()
      .min(1, nameRule)
      .max(apiKeyNameMaxLength, nameRule),
    access: ApiKeyAccessSchema,
    expiresInDays: ApiKeyExpirationSchema,
  },
  { error: "A name, access level, and expiration are required." },
);
export type ApiKeyInput = z.infer<typeof ApiKeyInputSchema>;

export const apiKeysRoutes = {
  list: route({
    method: "GET",
    path: "/api/organization-settings/api-keys",
    response: z.object({ apiKeys: z.array(ApiKeySchema) }),
  }),
  create: route({
    method: "POST",
    path: "/api/organization-settings/api-keys",
    body: ApiKeyInputSchema,
    response: z.object({
      apiKey: ApiKeySchema,
      /** The key's secret, sent only this once. */
      token: z.string(),
    }),
  }),
  revoke: route({
    method: "DELETE",
    path: "/api/organization-settings/api-keys/:id",
    response: z.object({ apiKey: ApiKeySchema }),
  }),
};
