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
    const page = await browser.newPage();
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
  } finally {
    await browser.close();
  }
}, 15_000);
