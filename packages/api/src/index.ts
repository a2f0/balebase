import { app } from "./app";
import { captureApiError } from "./diagnostics";
import { handleEmail } from "./email";
import { scheduleFinanceSync } from "./financeSyncJobs";
import { consumeFinanceSync } from "./financeSyncWorker";
import { maintenanceTasks, runScheduledMaintenance } from "./maintenance";
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
  queue: (batch, environment) => consumeFinanceSync(batch, environment),
  scheduled: (controller, environment, context) => {
    if (controller.cron === "*/5 * * * *") {
      context.waitUntil(
        scheduleFinanceSync(environment).catch(async (error: unknown) => {
          await captureApiError(error, "scheduled-error");
          throw error;
        }),
      );
      return;
    }
    context.waitUntil(
      runScheduledMaintenance(maintenanceTasks(environment), {
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
