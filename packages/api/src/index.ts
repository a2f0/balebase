import { app } from "./app";
import { handleEmail } from "./inbox/email";
import { scheduleJobs } from "./jobs/jobScheduler";
import { consumeJobs } from "./jobs/jobWorker";
import { runScheduledMaintenance } from "./jobs/maintenance";
import { captureApiError } from "./shared/diagnostics";
import type { Bindings } from "./types";

export default {
  email: async (message, environment) => {
    try {
      await handleEmail(message, environment);
    } catch (error) {
      await captureApiError(error, "email-error");
      throw error;
    }
  },
  fetch: app.fetch,
  queue: (batch, environment) => consumeJobs(batch, environment),
  scheduled: (controller, environment, context) => {
    if (controller.cron === "*/5 * * * *") {
      context.waitUntil(
        scheduleJobs(environment).catch(async (error: unknown) => {
          await captureApiError(error, "scheduled-error");
          throw error;
        }),
      );
      return;
    }
    context.waitUntil(
      runScheduledMaintenance(environment, {
        trigger: "scheduled",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }).catch(async (error: unknown) => {
        await captureApiError(error, "scheduled-error");
        throw error;
      }),
    );
  },
} satisfies ExportedHandler<Bindings, { jobId: string }>;
