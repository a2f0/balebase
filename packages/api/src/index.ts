import { app } from "./app";
import { captureApiError } from "./diagnostics";
import { handleEmail } from "./email";
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
  scheduled: (controller, environment, context) => {
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
} satisfies ExportedHandler<Bindings>;
