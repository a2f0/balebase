import { expect, it } from "bun:test";
import { cursorPage, decodeCursor, encodeCursor } from "./cursorPagination";

/** Encodes any JSON value the way `encodeCursor` encodes its pair. */
function wire(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

it("uses opaque Unicode-safe cursors", () => {
  const date = "2026-10-27T12:00:00.000Z";
  const id = "audit:東京/é";
  const encoded = encodeCursor(date, id);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeCursor(encoded, 2048)).toEqual([date, id]);
});

it("rejects malformed, oversized, empty, and non-string cursor components", () => {
  for (const input of [
    "",
    "not valid",
    "A",
    "%%%%",
    wire("not a pair"),
    wire(["date", "id", "extra"]),
    wire(["date", 1]),
    wire(["", "id"]),
    wire(["date", ""]),
    wire({ createdAt: "date", id: "id" }),
    JSON.stringify({ createdAt: "date", id: "id" }),
    btoa(JSON.stringify(["date", "id"])),
    btoa(String.fromCharCode(255)),
    encodeCursor("date", "x".repeat(1001)),
  ])
    expect(decodeCursor(input, 2048)).toBeNull();
  expect(decodeCursor(encodeCursor("date", "id"), 5)).toBeNull();
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
