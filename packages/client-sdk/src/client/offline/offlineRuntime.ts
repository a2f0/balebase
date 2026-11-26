import type { ApiClient } from "@balebase/api-client";
import type { Network } from "../runtime/network";
import type { OfflineStore } from "./offlineStore";

/** What offline sync works with; the `Offline` facade supplies it. */
export interface OfflineRuntime {
  api: ApiClient;
  network: Network;
  store: OfflineStore;
  /** Resolves once the host can reopen offline; see `BalebaseOptions`. */
  waitForOfflineShell: (() => Promise<void>) | undefined;
}
