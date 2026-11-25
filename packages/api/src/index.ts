import { app } from "./app";
import { handleEmail } from "./inbox/email";
import { scheduleJobs } from "./jobs/jobScheduler";
import { runDueMaintenance } from "./jobs/jobSchedules";
import { consumeJobs } from "./jobs/jobWorker";
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
    // Every other trigger, the minute one included, checks the maintenance
    // schedules saved in D1 against its own minute.
    context.waitUntil(
      runDueMaintenance(environment, controller.scheduledTime).catch(
        async (error: unknown) => {
          await captureApiError(error, "scheduled-error");
          throw error;
        },
      ),
    );
  },
} satisfies ExportedHandler<Bindings, { jobId: string }>;
