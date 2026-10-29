import { expect, it } from "bun:test";
import { routes } from "@balebase/validators/routes";
import { app } from "./app";

// Routes outside the contract: service metadata, webhooks that third parties
// sign, and the organization leave hook in front of Better Auth.
const uncontracted = new Set([
  "GET /",
  "GET /health",
  "POST /api/auth/organization/leave",
  "POST /api/billing/webhook",
  "POST /api/checkr/webhook",
]);

it("serves exactly the routes in the contract", () => {
  const served = new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  );
  const contract = new Set(
    Object.values(routes)
      .flatMap((area) => Object.values(area))
      .map((route) => `${route.method} ${route.path}`),
  );
  expect(
    [...served].filter(
      (route) => !contract.has(route) && !uncontracted.has(route),
    ),
  ).toEqual([]);
  expect([...contract].filter((route) => !served.has(route))).toEqual([]);
});
