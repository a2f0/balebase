import { createAuthClient } from "better-auth/client";
import {
  adminClient,
  inferAdditionalFields,
  multiSessionClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import type { ApiFetch } from "../runtime/apiFetch";

/**
 * The Better Auth client for the API's auth routes, with the plugins the API
 * enables. Its requests go through `fetch`, so like every other API call they
 * mark native requests and record the API version.
 */
export function createBalebaseAuthClient(apiBaseUrl: string, fetch: ApiFetch) {
  return createAuthClient({
    // Without an origin, Better Auth uses the page's, as the API client does.
    // Better Auth takes a base URL with a path as its whole route prefix, so
    // a proxy's path must come with the auth routes' own.
    baseURL: apiBaseUrl ? `${apiBaseUrl}/api/auth` : undefined,
    fetchOptions: {
      customFetchImpl: (input, init) => fetch(input, init),
    },
    plugins: [
      inferAdditionalFields({
        user: {
          termsAccepted: {
            required: false,
            returned: false,
            type: "boolean",
          },
        },
      }),
      adminClient(),
      multiSessionClient(),
      twoFactorClient(),
      organizationClient({ teams: { enabled: true } }),
    ],
  });
}

export type BalebaseAuthClient = ReturnType<typeof createBalebaseAuthClient>;
