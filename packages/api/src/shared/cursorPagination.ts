/** A descending sort value and unique ID form a stable keyset boundary. */
export function encodeCursor(value: string, id: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([value, id]));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Reads a cursor from `encodeCursor`, or null when it is not one. */
export function decodeCursor(
  value: string,
  maxLength: number,
): [string, string] | null {
  if (!value || value.length > maxLength) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const parts: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    );
    if (
      !Array.isArray(parts) ||
      parts.length !== 2 ||
      !parts.every(
        (part) =>
          typeof part === "string" && part.length > 0 && part.length <= 1000,
      )
    )
      return null;
    return parts as [string, string];
  } catch {
    return null;
  }
}

/** Queries fetch pageSize + 1 rows; the extra row only signals another page. */
export function cursorPage<Row>(
  rows: readonly Row[],
  pageSize: number,
  cursorFor: (row: Row) => string,
) {
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > pageSize && last !== undefined ? cursorFor(last) : null,
  };
}
