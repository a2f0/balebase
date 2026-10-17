import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "puppeteer-core";

it("preserves native CSRF markers through Capacitor's real browser fetch patch", async () => {
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
  try {
    const iosRoot = dirname(
      createRequire(import.meta.url).resolve("@capacitor/ios/package.json"),
    );
    const bridge = await readFile(
      join(iosRoot, "Capacitor/Capacitor/assets/native-bridge.js"),
      "utf8",
    );
    const bundle = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("../src/apiVersion.ts", import.meta.url)),
      ],
      target: "browser",
    });
    if (!bundle.success)
      throw new Error(`Native HTTP fixture failed: ${bundle.logs.join("\n")}`);
    const source = await bundle.outputs[0]?.text();
    if (!source) throw new Error("Native HTTP fixture is empty.");
    const filesBundle = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("../src/saveFile.ts", import.meta.url)),
      ],
      target: "browser",
    });
    const filesSource = await filesBundle.outputs[0]?.text();
    if (!filesBundle.success || !filesSource)
      throw new Error("File fixture failed");
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on(
      "request",
      (request) =>
        void request.respond({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body></body></html>",
        }),
    );
    await page.goto("https://localhost");
    await page.evaluate(() => {
      Reflect.set(window, "androidBridge", { postMessage() {} });
      Reflect.set(window, "CapacitorHttpAndroidInterface", {
        isEnabled: () => true,
      });
      Reflect.set(window, "WEBVIEW_SERVER_URL", "https://localhost");
    });
    await page.addScriptTag({ content: bridge });
    const requests = await page.evaluate(async (code) => {
      const calls: {
        headers: Record<string, string>;
        data: unknown;
        dataType: string;
      }[] = [];
      const capacitor = Reflect.get(window, "Capacitor");
      capacitor.nativePromise = async (
        _plugin: string,
        _method: string,
        options: (typeof calls)[number],
      ) => {
        calls.push(options);
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          data: { ok: true },
          url: "https://api.test/",
        };
      };
      const moduleUrl = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      const { fetchApi } = await import(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      // Chromium strips Origin from Request, unlike Bun's implementation.
      if (
        new Request("https://api.test", {
          headers: { Origin: "https://localhost" },
        }).headers.has("Origin")
      ) {
        throw new Error(
          "Browser fixture must enforce forbidden request headers.",
        );
      }
      await fetchApi("https://api.test/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const form = new FormData();
      form.set("file", new File([new Uint8Array([0, 255, 1])], "example.bin"));
      await fetchApi("https://api.test/api/objects", {
        method: "POST",
        body: form,
      });
      return calls;
    }, source);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const { "x-balebase-native-origin": nativeOrigin } = request.headers;
      expect(nativeOrigin).toBe("https://localhost");
    }
    expect(requests[1]?.dataType).toBe("formData");
    expect(requests[1]?.data).toEqual([
      expect.objectContaining({
        key: "file",
        value: "AP8B",
        type: "base64File",
      }),
    ]);
    const saved = await page.evaluate(async (code) => {
      const capacitor = Reflect.get(window, "Capacitor");
      capacitor.PluginHeaders = [
        {
          name: "Filesystem",
          methods: ["readdir", "writeFile", "rmdir"].map((name) => ({
            name,
            rtype: "promise",
          })),
        },
        { name: "Share", methods: [{ name: "share", rtype: "promise" }] },
      ];
      const calls: {
        plugin: string;
        method: string;
        options: Record<string, unknown> & { path?: string; files?: string[] };
      }[] = [];
      let canceled = false;
      capacitor.nativePromise = async (
        plugin: string,
        method: string,
        options: Record<string, unknown> & { path?: string; files?: string[] },
      ) => {
        calls.push({ plugin, method, options });
        if (method === "readdir")
          return {
            files: [
              { name: "stale", mtime: 0 },
              { name: "recent", mtime: Date.now() },
            ],
          };
        if (method === "writeFile")
          return { uri: `file:///cache/${options.path}` };
        if (method === "share" && canceled) throw new Error("Share canceled");
        return {};
      };
      const moduleUrl = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" }),
      );
      const { saveFile } = await import(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      const blob = new Blob([new Uint8Array([0, 255, 1])]);
      const success = await saveFile(blob, "../private.bin");
      canceled = true;
      const cancelResult = await saveFile(blob, "cancel.bin");
      return { calls, success, cancelResult };
    }, filesSource);
    expect(saved.success).toBe(true);
    expect(saved.cancelResult).toBe(false);
    const writes = saved.calls.filter((call) => call.method === "writeFile");
    expect(writes[0]?.options).toMatchObject({
      directory: "CACHE",
      data: "AP8B",
      recursive: true,
    });
    expect(writes[0]?.options.path).toMatch(
      /^downloads\/[^/]+\/_private\.bin$/,
    );
    expect(
      saved.calls.find((call) => call.method === "share")?.options.files,
    ).toEqual([`file:///cache/${writes[0]?.options.path}`]);
    const removals = saved.calls.filter((call) => call.method === "rmdir");
    expect(removals.map((call) => call.options.path)).toContain(
      "downloads/stale",
    );
    expect(removals.map((call) => call.options.path)).not.toContain(
      "downloads/recent",
    );
    expect(removals.at(-1)?.options.path).toBe(
      String(writes[1]?.options.path).replace(/\/[^/]+$/, ""),
    );
  } finally {
    await browser.close();
  }
}, 15_000);
