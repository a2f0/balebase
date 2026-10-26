import { type EvaluationInput, inputSchema } from "./evaluate";
import { trustedEvaluationRequest } from "./request";

export function judgeHandler(options: {
  port: number;
  model: string;
  version: string;
  evaluate: (input: EvaluationInput) => Promise<unknown>;
}) {
  let active = false;
  return async (request: Request, disableTimeout: () => void) => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return Response.json({
        status: "healthy",
        service: "judge",
        provider: "codex-cli",
        model: options.model,
        authentication: "ChatGPT",
        codexVersion: options.version,
        active,
      });
    }
    if (path !== "/api/v1/evaluate" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (!trustedEvaluationRequest(request, options.port))
      return Response.json(
        { error: "Only local non-browser JSON clients are allowed" },
        { status: 403 },
      );
    const parsed = inputSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      console.error(
        "[codex-judge] Invalid input",
        parsed.error.issues.map(({ code, path }) => ({ code, path })),
      );
      return Response.json(
        { error: "Invalid evaluation input" },
        { status: 400 },
      );
    }
    if (active)
      return Response.json(
        { error: "Judge is busy; retry evaluation" },
        { status: 503 },
      );
    active = true;
    try {
      disableTimeout();
      return Response.json(await options.evaluate(parsed.data));
    } catch (error) {
      console.error("[codex-judge]", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      active = false;
    }
  };
}
