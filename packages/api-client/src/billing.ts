import type { billingRoutes } from "@balebase/validators/billing";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  status: endpoint<typeof billingRoutes.status>({
    method: "GET",
    path: "/api/billing",
    response: "json",
  }),
  checkout: endpoint<typeof billingRoutes.checkout>({
    method: "POST",
    path: "/api/billing/checkout",
    response: "json",
  }),
  portal: endpoint<typeof billingRoutes.portal>({
    method: "POST",
    path: "/api/billing/portal",
    response: "json",
  }),
};

export function billingApi(transport: Transport) {
  return {
    /** The plan and usage; a Checkout return's session id confirms it first. */
    status(sessionId?: string) {
      return transport.call(endpoints.status, {
        query: { session_id: sessionId || undefined },
      });
    },
    /** Stripe's hosted Checkout page, or an inline session to embed. */
    createCheckoutSession() {
      return transport.call(endpoints.checkout);
    },
    createPortalSession() {
      return transport.call(endpoints.portal);
    },
  };
}
