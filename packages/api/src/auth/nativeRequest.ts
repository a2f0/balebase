const nativeOrigins = ["capacitor://localhost", "https://localhost"];

/** Apply the configured app origin after WebView Request strips native Origin. */
export function withNativeOrigin(request: Request, webOrigin: string) {
  const nativeOrigin = request.headers.get("X-Balebase-Native-Origin");
  // This marker is not authentication: cookies still authorize every action.
  // A browser Origin always wins, and CORS excludes the custom marker header.
  // Non-browser clients could already send the configured Origin directly.
  if (
    request.headers.has("Origin") ||
    !nativeOrigins.includes(nativeOrigin ?? "")
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("Origin", webOrigin);
  return new Request(request, { headers });
}
