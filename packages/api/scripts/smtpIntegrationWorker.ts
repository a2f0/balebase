// This test-only entry point dispatches both of the production Worker's
// event handlers against the same local D1 and R2 bindings.
import worker from "../src/index";
import type { Bindings } from "../src/types";

export default {
  async fetch(req, env, ctx) {
    if (new URL(req.url).pathname !== "/fixture/forward")
      return worker.fetch(req, env, ctx);
    let rejected = false;
    const bytes = await req.arrayBuffer();
    await worker.email(
      {
        from: "forwarder@example.org",
        to: req.headers.get("X-Recipient") ?? "",
        raw: new Blob([bytes]).stream(),
        headers: new Headers(),
        async forward() {
          throw new Error("Unexpected forwarding");
        },
        async reply() {
          throw new Error("Unexpected reply");
        },
        rawSize: bytes.byteLength,
        setReject() {
          rejected = true;
        },
      },
      env,
    );
    return new Response(null, { status: rejected ? 404 : 204 });
  },
} satisfies ExportedHandler<Bindings>;
