import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "puppeteer-core";

test("browser reports React and unhandled errors without application content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balebase-sentry-browser-"));
  const { CHROME_PATH } = process.env;
  const browser = await launch({
    executablePath:
      CHROME_PATH ||
      Bun.which("google-chrome") ||
      Bun.which("chromium") ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    pipe: true,
    args: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
  });
  const events: string[] = [];
  const entrypoint = join(directory, "index.ts");
  await Bun.write(
    entrypoint,
    `
    import { createBrowserDiagnostics } from ${JSON.stringify(resolve(import.meta.dir, "../../diagnostics/src/browser.ts"))};
    import { createElement } from ${JSON.stringify(resolve(import.meta.dir, "../node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(resolve(import.meta.dir, "../node_modules/react-dom/client.js"))};
    const diagnostics = createBrowserDiagnostics({
      dsn: "https://${"a".repeat(32)}@o1.ingest.us.sentry.io/1", target: "web", environment: "staging",
      release: "balebase-web@${"b".repeat(40)}", origin: location.origin, paths: new Set(["/assets/index.js"])
    });
    function Broken() { throw new Error("private customer content"); }
    createRoot(document.getElementById("root"), { onUncaughtError: (error) => diagnostics.captureError(error) }).render(createElement(Broken));
    window.fail = () => { setTimeout(() => { throw new TypeError("private token"); }, 0); };
    window.reject = () => Promise.reject(new RangeError("private password"));
  `,
  );
  const built = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!built.success || !built.outputs[0])
    throw new Error("Failed to bundle browser diagnostic fixture.");
  const javascript = await built.outputs[0].text();
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/assets/index.js"
        ? new Response(javascript, {
            headers: { "Content-Type": "text/javascript" },
          })
        : new Response(
            '<div id="root"></div><script type="module" src="/assets/index.js"></script>',
            { headers: { "Content-Type": "text/html" } },
          ),
  });
  try {
    const page = await browser.newPage();
    await page.exposeFunction("reports", () => events.length);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().includes(".sentry.io/")) {
        events.push(request.postData() ?? "");
        void request.respond({
          status: 200,
          body: "{}",
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } else void request.continue();
    });
    await page.goto(`http://localhost:${server.port}/private?token=private`);
    await page.waitForFunction("window.reports().then(count => count === 1)");
    await page.evaluate("window.fail(); window.reject(); void 0;");
    await page.waitForFunction("window.reports().then(count => count === 3)");
    expect(events.join("\n")).not.toContain("private");
    for (const event of events)
      expect(event).toContain('"filename":"app:///assets/index.js"');
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
