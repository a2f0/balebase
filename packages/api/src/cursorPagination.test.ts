import { expect, it } from "bun:test";
import { cursorPage, decodeCursor, encodeCursor } from "./cursorPagination";

it("uses opaque Unicode-safe cursors and accepts each previous wire format", () => {
  const date = "2026-10-27T12:00:00.000Z";
  const id = "audit:東京/é";
  const encoded = encodeCursor(date, id);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeCursor(encoded, "createdAt", 2048)).toEqual([date, id]);
  expect(
    decodeCursor(JSON.stringify({ date: "2026-10-27", id }), "date", 512),
  ).toEqual(["2026-10-27", id]);
  expect(
    decodeCursor(JSON.stringify({ createdAt: date, id }), "createdAt", 500),
  ).toEqual([date, id]);
  expect(
    decodeCursor(btoa(JSON.stringify([date, "job-1"])), "createdAt", 500),
  ).toEqual([date, "job-1"]);
  const legacyAudit = btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify({ createdAt: date, id })),
    ),
  );
  expect(
    decodeCursor(
      legacyAudit.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
      "createdAt",
      2048,
    ),
  ).toEqual([date, id]);
});

it("rejects malformed, oversized, empty, and non-string cursor components", () => {
  for (const input of [
    "",
    "not valid",
    "A",
    "%%%%",
    btoa("not json"),
    btoa(JSON.stringify(["date", "id", "extra"])),
    btoa(JSON.stringify(["date", 1])),
    btoa(JSON.stringify(["", "id"])),
    btoa(JSON.stringify(["date", ""])),
    JSON.stringify({ createdAt: "date" }),
    btoa(String.fromCharCode(255)),
    encodeCursor("date", "x".repeat(1001)),
  ])
    expect(decodeCursor(input, "createdAt", 2048)).toBeNull();
  expect(decodeCursor(encodeCursor("date", "id"), "createdAt", 5)).toBeNull();
  expect(
    decodeCursor(JSON.stringify({ date: "date", id: "id" }), "createdAt", 500),
  ).toBeNull();
});

it("uses the last visible row for continuation and never exposes the extra row", () => {
  const rows = [{ id: "c" }, { id: "b" }, { id: "a" }];
  expect(cursorPage(rows, 2, (row) => row.id)).toEqual({
    items: rows.slice(0, 2),
    nextCursor: "b",
  });
  expect(cursorPage(rows, 3, (row) => row.id)).toEqual({
    items: rows,
    nextCursor: null,
  });
  expect(cursorPage([], 3, String)).toEqual({ items: [], nextCursor: null });
  expect(rows).toHaveLength(3);
});
