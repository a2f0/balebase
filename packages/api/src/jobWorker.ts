import { isSyncJob } from "./financeSyncJobs";
import { runSyncPage } from "./financeSyncWorker";
import { claimJob } from "./jobRuns";
import { maintenanceTasks, runMaintenanceJob } from "./maintenance";
import { type PlaidRequest, plaidRequest } from "./plaid";
import type { Bindings } from "./types";

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
        const tasks = maintenanceTasks(env);
        const task = tasks[job.job_id as keyof typeof tasks];
        await runMaintenanceJob(env.DB, job, task);
      }
      message.ack();
    } catch {
      console.error({
        event: "job_delivery_failed",
        jobId: message.body.jobId,
      });
      message.retry({ delaySeconds: 60 });
    }
  }
}
