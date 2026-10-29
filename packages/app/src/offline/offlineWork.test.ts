import { expect, it } from "bun:test";
import type { AuditTemplate } from "@balebase/validators/audits";
import { createOfflineIssue, offlineDownloadState } from "./offlineWork";

it("treats a downloaded form as current until a newer version is listed", () => {
  const saved = [{ id: "form", version: 3 }] as AuditTemplate[];
  expect(offlineDownloadState(undefined, { id: "form", version: 1 })).toBe(
    "missing",
  );
  expect(offlineDownloadState(saved, { id: "other", version: 3 })).toBe(
    "missing",
  );
  expect(offlineDownloadState(saved, { id: "form", version: 3 })).toBe(
    "current",
  );
  expect(offlineDownloadState(saved, { id: "form", version: 2 })).toBe(
    "current",
  );
  expect(offlineDownloadState(saved, { id: "form", version: 4 })).toBe(
    "outdated",
  );
});

it("refuses photos the API would refuse before saving an issue on the device", async () => {
  const issue = {
    assignedTo: null,
    description: "",
    priority: "medium" as const,
    title: "Cracked panel cover",
  };
  const photo = (bytes: number, type: string) =>
    new File([new Uint8Array(bytes)], "photo.png", { type });

  await expect(
    createOfflineIssue("workspace", issue, [photo(0, "image/png")]),
  ).rejects.toThrow("Images must not be empty.");
  await expect(
    createOfflineIssue("workspace", issue, [photo(4, "image/heic")]),
  ).rejects.toThrow("Images must be JPEG, PNG, GIF, or WebP files.");
  await expect(
    createOfflineIssue(
      "workspace",
      issue,
      Array.from({ length: 11 }, () => photo(4, "image/png")),
    ),
  ).rejects.toThrow("You can attach 10 more images.");
});
