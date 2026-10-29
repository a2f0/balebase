import { expect, it } from "bun:test";

it("routes the finance cron independently from hourly maintenance and exposes the queue consumer", async () => {
  const { spyOn } = await import("bun:test");
  const jobs = await import("./jobScheduler");
  const consumer = await import("./jobWorker");
  const maintenance = await import("./maintenance");
  const worker = (await import("./index")).default;
  const finance = spyOn(jobs, "scheduleJobs").mockResolvedValue({
    scheduled: 0,
    dispatched: 0,
  });
  const hourly = spyOn(
    maintenance,
    "runScheduledMaintenance",
  ).mockResolvedValue(undefined);
  const queue = spyOn(consumer, "consumeJobs").mockResolvedValue(undefined);
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

it("attempts both queue recovery and daily scheduling when either fails", async () => {
  const { spyOn } = await import("bun:test");
  const jobs = await import("./jobRuns");
  const finance = await import("./finance/financeSyncJobs");
  const { scheduleJobs } = await import("./jobScheduler");
  const recover = spyOn(jobs, "recoverJobs").mockResolvedValue(1);
  const daily = spyOn(finance, "scheduleFinanceSync").mockResolvedValue(2);
  const environment = {} as import("./types").Bindings;
  try {
    recover.mockRejectedValueOnce(new Error("recovery unavailable"));
    await expect(scheduleJobs(environment)).rejects.toThrow(
      "Background scheduling failed.",
    );
    expect(daily).toHaveBeenCalledTimes(1);
    daily.mockRejectedValueOnce(new Error("daily scheduling unavailable"));
    await expect(scheduleJobs(environment)).rejects.toThrow(
      "Background scheduling failed.",
    );
    expect(recover).toHaveBeenCalledTimes(2);
    expect(await scheduleJobs(environment)).toEqual({
      scheduled: 2,
      dispatched: 1,
    });
  } finally {
    recover.mockRestore();
    daily.mockRestore();
  }
});
