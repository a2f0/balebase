import { describe, expect, it } from "bun:test";
import { api } from "../shared/apiClient";
import { apiUrl } from "../shared/config";
import { installFetch } from "../testing/fetch";

const respond = installFetch();

describe("signing requests", () => {
  it("authorizes with the token alone, never cookies", async () => {
    const requests: Array<{
      body: unknown;
      headers: unknown;
      method: string;
      url: string;
    }> = [];
    respond(async (url, init) => {
      requests.push({
        body: init?.body,
        headers: init?.headers,
        method: init?.method ?? "GET",
        url: url.href,
      });
      expect(init?.credentials).toBe("omit");
      return Response.json({ status: "signed" });
    });

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
    expect(api.signing.finalUrl("tok")).toBe(`${apiUrl}/api/signing/tok/final`);
  });

  it("surfaces the API's error message", async () => {
    respond(async () =>
      Response.json(
        { error: "This signing link is no longer valid." },
        { status: 404 },
      ),
    );
    await expect(api.signing.get("tok")).rejects.toThrow(
      "This signing link is no longer valid.",
    );
  });
});
