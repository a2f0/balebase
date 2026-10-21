import { describe, expect, it } from "bun:test";
import { api } from "./apiClient";
import { apiUrl } from "./config";

describe("inbox API", () => {
  it("addresses the Trash lifecycle endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = input.toString();
      requests.push({ method: init?.method ?? "GET", url });
      expect(init?.credentials).toBe("include");
      if (url.endsWith("/restore") || url.endsWith("/archive")) {
        return Response.json({ emailId: "message/id" });
      }
      if (init?.method === "DELETE") {
        return Response.json({
          deletedAt: "2026-08-21T12:00:00.000Z",
          deletedByUserId: "user-id",
          emailId: "message/id",
        });
      }
      if (url.includes("message%2Fid")) {
        return Response.json({ email: {} });
      }
      return Response.json({ address: "upload@example.com", emails: [] });
    }) as typeof fetch;

    try {
      await api.inbox.list("trash");
      await api.inbox.get("message/id", "trash");
      await api.inbox.delete("message/id");
      await api.inbox.restore("message/id");
      await api.inbox.archive("message/id");
      await api.inbox.list("archived");
      await api.inbox.get("message/id", "archived");
      expect(requests).toEqual([
        { method: "GET", url: `${apiUrl}/api/inbox?folder=trash` },
        {
          method: "GET",
          url: `${apiUrl}/api/inbox/message%2Fid?folder=trash`,
        },
        { method: "DELETE", url: `${apiUrl}/api/inbox/message%2Fid` },
        {
          method: "POST",
          url: `${apiUrl}/api/inbox/message%2Fid/restore`,
        },
        { method: "POST", url: `${apiUrl}/api/inbox/message%2Fid/archive` },
        { method: "GET", url: `${apiUrl}/api/inbox?folder=archived` },
        {
          method: "GET",
          url: `${apiUrl}/api/inbox/message%2Fid?folder=archived`,
        },
      ]);
      expect(
        api.inbox.attachmentUrl("message/id", "attachment/id", "trash"),
      ).toBe(
        `${apiUrl}/api/inbox/message%2Fid/attachments/attachment%2Fid?folder=trash`,
      );
      expect(
        api.inbox.attachmentUrl("message/id", "attachment/id", "archived"),
      ).toBe(
        `${apiUrl}/api/inbox/message%2Fid/attachments/attachment%2Fid?folder=archived`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
