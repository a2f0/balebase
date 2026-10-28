import { describe, expect, it } from "bun:test";
import { api } from "./apiClient";

describe("library and link API", () => {
  it("trims a transaction search and leaves a blank one unfiltered", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(input.toString());
      return Response.json({ transactions: [] });
    }) as typeof fetch;

    try {
      await api.finance.searchTransactions("  $42.75 ");
      await api.finance.searchTransactions(" ");
      expect(urls.map((url) => new URL(url).search)).toEqual([
        "?q=%2442.75",
        "",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uploads into a folder only when one is given", async () => {
    const originalFetch = globalThis.fetch;
    const forms: FormData[] = [];
    globalThis.fetch = (async (_input, init) => {
      forms.push(init?.body as FormData);
      return Response.json({ object: {} });
    }) as typeof fetch;

    try {
      const file = new File(["x"], "a.txt");
      await api.objects.upload(file, "folder/1");
      await api.objects.upload(file);
      expect(forms.map((form) => form.get("folderId"))).toEqual([
        "folder/1",
        null,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
