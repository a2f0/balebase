import { isSyncJob } from "../finance/financeSyncJobs";
import { runSyncPage } from "../finance/financeSyncWorker";
import { type PlaidRequest, plaidRequest } from "../finance/plaid";
import type { Bindings } from "../types";
import { claimJob } from "./jobRuns";
import { maintenanceTask, runMaintenanceJob } from "./maintenance";

export async function consumeJobs(
  batch: MessageBatch<{ jobId: string }>,
  env: Bindings,
  requestPlaid: PlaidRequest = plaidRequest,
) {
  for (const message of batch.messages) {
    try {
      const job = await claimJob(env.DB, message.body.jobId);
      if (job && isSyncJob(job)) {
        await runSyncPage(env, job, requestPlaid);
      } else if (job) {
        await runMaintenanceJob(env.DB, job, maintenanceTask(env, job));
      }
      message.ack();
    } catch (error) {
      console.error(
        { event: "job_delivery_failed", jobId: message.body.jobId },
        error,
      );
      message.retry({ delaySeconds: 60 });
    }
  }
}
