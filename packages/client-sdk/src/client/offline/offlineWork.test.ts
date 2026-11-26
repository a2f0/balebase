import { expect, it } from "bun:test";
import { Balebase } from "../../Balebase";

it("binds every member, so screens can pass them on as callbacks", () => {
  const { offline } = new Balebase({ apiBaseUrl: "https://api.test" });
  const { scopeKey } = offline;
  expect(scopeKey({ organizationId: "org", userId: "user" })).toBe(
    JSON.stringify(["https://api.test", "user", "org"]),
  );
  for (const [name, member] of Object.entries(offline)) {
    expect([name, typeof member]).toEqual([name, "function"]);
  }
  expect(Object.keys(offline)).toContain("sync");
  expect(Object.keys(offline)).not.toContain("change");
});

it("refuses photos the API would refuse before saving an issue on the device", async () => {
  const { offline } = new Balebase({ apiBaseUrl: "https://api.test" });
  const issue = {
    assignedTo: null,
    description: "",
    priority: "medium" as const,
    title: "Cracked panel cover",
  };
  const target = { formId: "form", itemId: "item" };
  const photo = (bytes: number, type: string) =>
    new File([new Uint8Array(bytes)], "photo.png", { type });

  await expect(
    offline.createIssue("workspace", issue, [photo(0, "image/png")], target),
  ).rejects.toThrow("Images must not be empty.");
  await expect(
    offline.createIssue("workspace", issue, [photo(4, "image/heic")], target),
  ).rejects.toThrow("Images must be JPEG, PNG, GIF, or WebP files.");
  await expect(
    offline.createIssue(
      "workspace",
      issue,
      Array.from({ length: 11 }, () => photo(4, "image/png")),
      target,
    ),
  ).rejects.toThrow("You can attach 10 more images.");
});
