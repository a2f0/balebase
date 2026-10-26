import { expect, it } from "bun:test";
import { runScheduledMaintenance } from "./maintenance";

it("tombstones expired audit images before scheduled cleanup", async () => {
  const events: string[] = [];
  let releaseRetention: () => void = () => undefined;
  const retentionFinished = new Promise<void>((resolve) => {
    releaseRetention = resolve;
  });
  const maintenance = runScheduledMaintenance({
    purgeRequestedUsers: async () => events.push("users"),
    purgeDeletedObjects: async () => events.push("deleted objects"),
    purgeExpiredFreeAuditRuns: async () => {
      events.push("retention started");
      await retentionFinished;
      events.push("retention finished");
    },
    purgePendingAuditIssueImages: async () => events.push("issue images"),
    purgeStripeWebhookReceipts: async () => events.push("webhook receipts"),
    reconcileSubscriptionSeats: async () => events.push("seats"),
    maintainContracts: async () => events.push("contracts"),
    refreshCheckrScreenings: async () => events.push("checkr screenings"),
  });

  await Promise.resolve();
  expect(events).toEqual(["retention started"]);
  releaseRetention();
  await maintenance;
  expect(events).toEqual([
    "retention started",
    "retention finished",
    "users",
    "deleted objects",
    "issue images",
    "webhook receipts",
    "seats",
    "contracts",
    "checkr screenings",
  ]);
});

it("runs independent maintenance after retention fails", async () => {
  const events: string[] = [];
  const retentionFailure = new Error("retention failed");
  const maintenance = runScheduledMaintenance({
    purgeRequestedUsers: async () => events.push("users"),
    purgeDeletedObjects: async () => events.push("deleted objects"),
    purgeExpiredFreeAuditRuns: async () => {
      events.push("retention");
      throw retentionFailure;
    },
    purgePendingAuditIssueImages: async () => events.push("issue images"),
    purgeStripeWebhookReceipts: async () => events.push("webhook receipts"),
    reconcileSubscriptionSeats: async () => events.push("seats"),
    maintainContracts: async () => events.push("contracts"),
    refreshCheckrScreenings: async () => events.push("checkr screenings"),
  });

  await expect(maintenance).rejects.toThrow("Scheduled maintenance failed.");
  expect(events).toEqual([
    "retention",
    "users",
    "deleted objects",
    "issue images",
    "webhook receipts",
    "seats",
    "contracts",
    "checkr screenings",
  ]);
});

it("routes the finance cron independently from hourly maintenance and exposes the queue consumer", async () => {
  const { spyOn } = await import("bun:test");
  const jobs = await import("./financeSyncJobs");
  const consumer = await import("./financeSyncWorker");
  const maintenance = await import("./maintenance");
  const worker = (await import("./index")).default;
  const finance = spyOn(jobs, "scheduleFinanceSync").mockResolvedValue({
    scheduled: 0,
    dispatched: 0,
  });
  const hourly = spyOn(
    maintenance,
    "runScheduledMaintenance",
  ).mockResolvedValue(undefined);
  const queue = spyOn(consumer, "consumeFinanceSync").mockResolvedValue(
    undefined,
  );
  const environment = {} as import("./types").Bindings;
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as ExecutionContext;
  try {
    worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: 123 } as ScheduledController,
      environment,
      context,
    );
    await Promise.all(pending.splice(0));
    expect(finance).toHaveBeenCalledWith(environment);
    expect(hourly).not.toHaveBeenCalled();
    worker.scheduled(
      { cron: "17 * * * *", scheduledTime: 456 } as ScheduledController,
      environment,
      context,
    );
    await Promise.all(pending.splice(0));
    expect(finance).toHaveBeenCalledTimes(1);
    expect(hourly).toHaveBeenCalledTimes(1);
    const batch = { messages: [] } as unknown as MessageBatch<{
      jobId: string;
    }>;
    await worker.queue(batch, environment);
    expect(queue).toHaveBeenCalledWith(batch, environment);
    finance.mockRejectedValueOnce(new Error("Finance scheduling failed"));
    worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: 789 } as ScheduledController,
      environment,
      context,
    );
    await expect(Promise.all(pending)).rejects.toThrow(
      "Finance scheduling failed",
    );
  } finally {
    finance.mockRestore();
    hourly.mockRestore();
    queue.mockRestore();
  }
});
