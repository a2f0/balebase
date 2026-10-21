import { ApiClient } from "@balebase/api-client";
import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

/** The API. Calls go through fetchApi, which records each response's version. */
export const api = new ApiClient({ baseUrl: apiUrl, fetch: fetchApi });
