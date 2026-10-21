import { describe, expect, it } from "bun:test";
import { api } from "./apiClient";
import { apiUrl } from "./config";

describe("contracts API", () => {
  it("addresses the contract endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        body: init?.body,
        method: init?.method ?? "GET",
        url: input.toString(),
      });
      expect(init?.credentials).toBe("include");
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ contract: { id: "c/1" }, contracts: [] });
    }) as typeof fetch;

    try {
      const draft = {
        dueDate: "2026-10-01",
        fields: [],
        message: "",
        recipients: [],
        reminderIntervalDays: 3,
        signingOrder: "parallel" as const,
        title: "Lease",
      };
      await api.contracts.list();
      await api.contracts.upload(new File(["%PDF-"], "lease.pdf"));
      await api.contracts.get("c/1");
      await api.contracts.saveDraft("c/1", draft);
      await api.contracts.send("c/1");
      await api.contracts.remind("c/1");
      await api.contracts.void("c/1", "Wrong terms");
      await api.contracts.delete("c/1");
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${apiUrl}/api/contracts`,
        `POST ${apiUrl}/api/contracts`,
        `GET ${apiUrl}/api/contracts/c%2F1`,
        `PUT ${apiUrl}/api/contracts/c%2F1/draft`,
        `POST ${apiUrl}/api/contracts/c%2F1/send`,
        `POST ${apiUrl}/api/contracts/c%2F1/remind`,
        `POST ${apiUrl}/api/contracts/c%2F1/void`,
        `DELETE ${apiUrl}/api/contracts/c%2F1`,
      ]);
      const form = requests[1]?.body as FormData;
      expect((form.get("file") as File).name).toBe("lease.pdf");
      expect(requests[3]?.body).toBe(JSON.stringify(draft));
      expect(requests[6]?.body).toBe(JSON.stringify({ reason: "Wrong terms" }));
      expect(api.contracts.documentUrl("c/1")).toBe(
        `${apiUrl}/api/contracts/c%2F1/document`,
      );
      expect(api.contracts.finalUrl("c/1")).toBe(
        `${apiUrl}/api/contracts/c%2F1/final`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs a draft's saves in order and reads after them", async () => {
    const originalFetch = globalThis.fetch;
    const log: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls += 1;
      const call = calls;
      log.push(`start ${init?.method ?? "GET"}`);
      if (call === 1) await firstHeld;
      log.push(`end ${call}`);
      return Response.json({ contract: { id: "c1" } });
    }) as typeof fetch;
    try {
      const draft = {
        dueDate: null,
        fields: [],
        message: "",
        recipients: [],
        reminderIntervalDays: null,
        signingOrder: "parallel" as const,
        title: "Lease",
      };
      const first = api.contracts.saveDraft("c1", draft);
      const second = api.contracts.saveDraft("c1", {
        ...draft,
        title: "Lease v2",
      });
      const read = api.contracts.get("c1");
      await Bun.sleep(5);
      expect(log).toEqual(["start PUT"]);
      releaseFirst();
      await Promise.all([first, second, read]);
      expect(log).toEqual([
        "start PUT",
        "end 1",
        "start PUT",
        "end 2",
        "start GET",
        "end 3",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the API's error message", async () => {
    const originalFetch = globalThis.fetch;
    let status = 400;
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      status === 400
        ? Response.json({ error: "Add at least one signer." }, { status })
        : new Response("upstream failure", { status })) as typeof fetch;
    try {
      await expect(api.contracts.send("c1")).rejects.toThrow(
        "Add at least one signer.",
      );
      status = 502;
      await expect(
        api.contracts.upload(new File(["x"], "x.pdf")),
      ).rejects.toThrow("Request failed with status 502.");
      await expect(api.contracts.delete("c1")).rejects.toThrow(
        "Request failed with status 502.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
