import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";

it("preserves native CSRF markers through Capacitor's real browser fetch patch", async () => {
  const browser = await launch(chromeLaunchOptions());
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
        fileURLToPath(new URL("./nativeHttpFixture.ts", import.meta.url)),
      ],
      target: "browser",
    });
    if (!bundle.success)
      throw new Error(`Native HTTP fixture failed: ${bundle.logs.join("\n")}`);
    const source = await bundle.outputs[0]?.text();
    if (!source) throw new Error("Native HTTP fixture is empty.");
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    const binaryBytes = [0, 255, 1, 128, 37, 80, 68, 70];
    const proxyRequests: {
      remote: string | null;
      marker: string | undefined;
    }[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/_capacitor_http_interceptor_") {
        const remote = url.searchParams.get("u");
        proxyRequests.push({
          remote,
          marker: request.headers()["x-balebase-native-origin"],
        });
        void request.respond({
          status: 200,
          contentType: remote?.endsWith(".pdf")
            ? "application/pdf"
            : "image/png",
          body: Buffer.from(binaryBytes),
        });
        return;
      }
      void request.respond({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    await page.goto("https://localhost");
    await page.evaluate(() => {
      Reflect.set(window, "androidBridge", { postMessage() {} });
      Reflect.set(window, "CapacitorHttpAndroidInterface", {
        isEnabled: () => true,
      });
      Reflect.set(window, "WEBVIEW_SERVER_URL", "https://localhost");
    });
    await page.addScriptTag({ content: bridge });
    const transport = await page.evaluate(async (code) => {
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
      // Capacitor 8 sends GET downloads through its local native HTTP proxy,
      // which streams raw bytes. Its nativePromise/base64 path is for mutations.
      // Exercise the actual fetch patch, not a replacement fetch implementation.
      const downloads = [];
      for (const extension of ["pdf", "png"]) {
        const response = await fetchApi(
          `https://api.test/private.${extension}`,
          { credentials: "include" },
        );
        const blob = await response.clone().blob();
        downloads.push({
          type: blob.type,
          blob: Array.from(new Uint8Array(await blob.arrayBuffer())),
          buffer: Array.from(new Uint8Array(await response.arrayBuffer())),
        });
      }
      return { calls, downloads };
    }, source);
    const requests = transport.calls;
    expect(proxyRequests).toEqual([
      { remote: "https://api.test/private.pdf", marker: "https://localhost" },
      { remote: "https://api.test/private.png", marker: "https://localhost" },
    ]);
    expect(transport.downloads).toEqual([
      { type: "application/pdf", blob: binaryBytes, buffer: binaryBytes },
      { type: "image/png", blob: binaryBytes, buffer: binaryBytes },
    ]);
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
    }, source);
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
    await closeChrome(browser);
  }
}, 15_000);
