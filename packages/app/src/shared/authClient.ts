import {
  adminClient,
  inferAdditionalFields,
  multiSessionClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { balebase } from "../balebase";
import { apiUrl } from "./config";

export const authClient = createAuthClient({
  baseURL: apiUrl,
  // Like the app's other API calls, go through the SDK's fetch: it looks fetch
  // up per request, marks native requests, and records the API version.
  fetchOptions: {
    customFetchImpl: (input, init) => balebase().fetch(input, init),
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
