import { describe, expect, it } from "bun:test";
import { api } from "./apiClient";
import { apiUrl } from "./config";

describe("signing requests", () => {
  it("authorizes with the token alone, never cookies", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      body: unknown;
      headers: unknown;
      method: string;
      url: string;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        body: init?.body,
        headers: init?.headers,
        method: init?.method ?? "GET",
        url: input.toString(),
      });
      expect(init?.credentials).toBe("omit");
      return Response.json({ status: "signed" });
    }) as typeof fetch;

    try {
      const signature = {
        consent: true,
        signature: "data:image/png;base64,AA==",
        values: { f1: "Acme" },
      };
      await api.signing.get("tok");
      await api.signing.sign("tok", signature);
      await api.signing.decline("tok", "Wrong rate");
      await api.signing.document("tok");
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${apiUrl}/api/signing/tok`,
        `POST ${apiUrl}/api/signing/tok/sign`,
        `POST ${apiUrl}/api/signing/tok/decline`,
        `GET ${apiUrl}/api/signing/tok/document`,
      ]);
      expect(requests[0]?.headers).toBeUndefined();
      expect(requests[1]?.headers).toEqual({
        "Content-Type": "application/json",
      });
      expect(requests[1]?.body).toBe(JSON.stringify(signature));
      expect(requests[2]?.body).toBe(JSON.stringify({ reason: "Wrong rate" }));
      expect(api.signing.documentUrl("tok")).toBe(
        `${apiUrl}/api/signing/tok/document`,
      );
      expect(api.signing.finalUrl("tok")).toBe(
        `${apiUrl}/api/signing/tok/final`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the API's error message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      Response.json(
        { error: "This signing link is no longer valid." },
        { status: 404 },
      )) as typeof fetch;
    try {
      await expect(api.signing.get("tok")).rejects.toThrow(
        "This signing link is no longer valid.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
