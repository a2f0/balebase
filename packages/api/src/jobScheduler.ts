import { scheduleFinanceSync } from "./financeSyncJobs";
import { recoverJobs } from "./jobRuns";
import type { Bindings } from "./types";

export async function scheduleJobs(env: Bindings, timestamp = Date.now()) {
  // Recover all job types before scheduling new finance work.
  const dispatched = await recoverJobs(env, timestamp);
  const scheduled = await scheduleFinanceSync(env, timestamp);
  return { scheduled, dispatched };
}
