import { describe, expect, it } from "bun:test";
import { api } from "./shared/apiClient";
import { installFetch } from "./testing/fetch";

const respond = installFetch();

describe("library and link API", () => {
  it("trims a transaction search and leaves a blank one unfiltered", async () => {
    const urls: string[] = [];
    respond(async (url) => {
      urls.push(url.href);
      return Response.json({ transactions: [] });
    });

    await api.finance.searchTransactions("  $42.75 ");
    await api.finance.searchTransactions(" ");
    expect(urls.map((url) => new URL(url).search)).toEqual(["?q=%2442.75", ""]);
  });

  it("uploads into a folder only when one is given", async () => {
    const forms: FormData[] = [];
    respond(async (_url, init) => {
      forms.push(init?.body as FormData);
      return Response.json({ object: {} });
    });

    const file = new File(["x"], "a.txt");
    await api.objects.upload(file, "folder/1");
    await api.objects.upload(file);
    expect(forms.map((form) => form.get("folderId"))).toEqual([
      "folder/1",
      null,
    ]);
  });
});
