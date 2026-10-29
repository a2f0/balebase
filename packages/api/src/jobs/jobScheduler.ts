import { scheduleFinanceSync } from "../finance/financeSyncJobs";
import type { Bindings } from "../types";
import { recoverJobs } from "./jobRuns";

export async function scheduleJobs(env: Bindings, timestamp = Date.now()) {
  // An unavailable outbox or retention cleanup must not skip daily scheduling,
  // and a daily scheduling failure must not skip recovery of other job types.
  const [recovery, daily] = await Promise.allSettled([
    recoverJobs(env, timestamp),
    scheduleFinanceSync(env, timestamp),
  ]);
  if (recovery.status === "rejected" || daily.status === "rejected")
    throw new AggregateError(
      [recovery, daily].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
      "Background scheduling failed.",
    );
  return { scheduled: daily.value, dispatched: recovery.value };
}
