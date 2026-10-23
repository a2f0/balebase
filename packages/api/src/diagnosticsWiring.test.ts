import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("production Worker entrypoints report failures without changing their behavior", async () => {
  // Keep dependency mocks out of the real application's other tests.
  const parent = resolve(import.meta.dir, "../.wrangler");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "diagnostics-wiring-"));
  try {
    const fixture = resolve(directory, "wiring.test.ts");
    await writeFile(
      fixture,
      `
      import { expect, mock, test } from "bun:test";
      const reports = [];
      const maintenance = await import(${JSON.stringify(resolve(import.meta.dir, "maintenance.ts"))});
      const requestError = new TypeError("request failure");
      const emailError = new TypeError("email failure");
      const scheduledError = new TypeError("scheduled failure");
      mock.module(${JSON.stringify(resolve(import.meta.dir, "diagnostics.ts"))}, () => ({ captureApiError: async (error, source) => { reports.push({ error, source }); } }));
      mock.module(${JSON.stringify(resolve(import.meta.dir, "email.ts"))}, () => ({ handleEmail: async () => { throw emailError; } }));
      mock.module(${JSON.stringify(resolve(import.meta.dir, "maintenance.ts"))}, () => ({ ...maintenance, maintenanceTasks: () => [], runScheduledMaintenance: async () => { throw scheduledError; } }));
      const { app } = await import(${JSON.stringify(resolve(import.meta.dir, "app.ts"))});
      const { default: worker } = await import(${JSON.stringify(resolve(import.meta.dir, "index.ts"))});
      app.get("/__diagnostics_test__", () => { throw requestError; });
      test("HTTP responses retain their error response and wait for reporting", async () => {
        const pending = [];
        const response = await worker.fetch(new Request("https://example.com/__diagnostics_test__"), {}, { waitUntil: (promise) => pending.push(promise) });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "Unexpected server error." });
        expect(pending).toHaveLength(1);
        await Promise.all(pending);
        expect(reports.at(-1)).toEqual({ error: requestError, source: "request-error" });
      });
      test("email failure is reported and rethrown", async () => {
        await expect(worker.email({}, {})).rejects.toBe(emailError);
        expect(reports.at(-1)).toEqual({ error: emailError, source: "email-error" });
      });
      test("scheduled failure remains a rejected waitUntil promise", async () => {
        const pending = [];
        worker.scheduled({ cron: "0 * * * *", scheduledTime: 1 }, {}, { waitUntil: (promise) => pending.push(promise) });
        expect(pending).toHaveLength(1);
        await expect(pending[0]).rejects.toBe(scheduledError);
        expect(reports.at(-1)).toEqual({ error: scheduledError, source: "scheduled-error" });
      });
    `,
    );
    const child = Bun.spawn([process.execPath, "test", fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
