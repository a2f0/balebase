import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("renderApp forwards all React root errors to its host", async () => {
  // Isolate module mocks from the app's other tests.
  const parent = resolve(import.meta.dir, "../.wrangler");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "client-wiring-"));
  try {
    const fixture = resolve(directory, "wiring.test.tsx");
    await writeFile(
      fixture,
      `
      import { expect, mock, test } from "bun:test";
      let options;
      let rendered = false;
      mock.module("react-dom/client", () => ({ createRoot: (_root, next) => {
        options = next;
        return { render() { rendered = true; } };
      } }));
      mock.module("@balebase/ui/react", () => ({ DialogHost: () => null, ToastProvider: () => null }));
      mock.module(${JSON.stringify(resolve(import.meta.dir, "App.tsx"))}, () => ({ App: () => null }));
      mock.module(${JSON.stringify(resolve(import.meta.dir, "workspace/AppBoundary.tsx"))}, () => ({ AppBoundary: () => null }));
      mock.module(${JSON.stringify(resolve(import.meta.dir, "account/theme.ts"))}, () => ({ startThemeSync() {} }));
      globalThis.document = { getElementById: () => ({}) };
      const { renderApp } = await import(${JSON.stringify(resolve(import.meta.dir, "client.tsx"))});
      test("production root callbacks preserve errors and classification", () => {
        const reports = [];
        renderApp({ captureError: (error, source) => reports.push({ error, source }) });
        expect(rendered).toBe(true);
        for (const [callback, source] of [["onCaughtError", "boundary"], ["onUncaughtError", "uncaught-react"], ["onRecoverableError", "boundary"]]) {
          const error = new TypeError(callback);
          options[callback](error, {});
          expect(reports.at(-1)).toEqual({ error, source });
        }
        expect(reports).toHaveLength(3);
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
