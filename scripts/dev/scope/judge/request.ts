/** Block browser simple requests and unexpected Host names on the local judge. */
export function trustedEvaluationRequest(
  request: Request,
  port: number,
): boolean {
  const url = new URL(request.url);
  return (
    !request.headers.has("Origin") &&
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ===
      "application/json" &&
    [
      "127.0.0.1",
      "localhost",
      "[::1]",
      "host.docker.internal",
      "host.containers.internal",
    ].includes(url.hostname) &&
    url.port === String(port)
  );
}
