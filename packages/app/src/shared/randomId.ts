/**
 * A random ID. `crypto.randomUUID` exists only in secure contexts (not plain
 * HTTP on a local network), and this module loads with the app.
 */
export function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
