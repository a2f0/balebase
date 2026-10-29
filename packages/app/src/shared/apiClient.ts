import { ApiClient } from "@balebase/api-client";
import { fetchApi } from "../apiVersion";
import { apiUrl } from "./config";

/** The API. Calls go through fetchApi, which records each response's version. */
export const api = new ApiClient({
  baseUrl: apiUrl,
  fetch: (input, init) =>
    fetchApi(
      input,
      input.includes("/api/offline/")
        ? { ...init, signal: AbortSignal.timeout(90_000) }
        : init?.method === "GET" && input.includes("/api/admin/jobs/runs/")
          ? { ...init, signal: AbortSignal.timeout(30_000) }
          : init,
    ),
});
