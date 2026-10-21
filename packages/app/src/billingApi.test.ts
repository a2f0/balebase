import { afterEach, describe, expect, it } from "bun:test";
import { api } from "./apiClient";
import { openCurrentBillingSession } from "./billingSession";
import { apiUrl } from "./config";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("billing API", () => {
  it("confirms Checkout and creates Stripe redirects", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
      });
      if (String(input).endsWith("/checkout")) {
        return Response.json({ url: "https://checkout.stripe.test" });
      }
      if (String(input).endsWith("/portal")) {
        return Response.json({ url: "https://billing.stripe.test" });
      }
      return Response.json({
        billing: {
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          status: "active",
        },
        canManage: true,
        current: { formTemplates: 2, members: 3 },
        limits: { formTemplates: null, retentionDays: null, users: null },
        plan: "pro",
        pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
        seats: 3,
      });
    }) as typeof fetch;

    await api.billing.status("cs_test/session");
    expect(await api.billing.createCheckoutSession()).toEqual({
      url: "https://checkout.stripe.test",
    });
    expect(await api.billing.createPortalSession()).toEqual({
      url: "https://billing.stripe.test",
    });
    expect(requests).toEqual([
      {
        method: "GET",
        url: `${apiUrl}/api/billing?session_id=cs_test%2Fsession`,
      },
      { method: "POST", url: `${apiUrl}/api/billing/checkout` },
      { method: "POST", url: `${apiUrl}/api/billing/portal` },
    ]);
  });

  it("surfaces API billing errors", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "Organization billing access is required." },
        { status: 403 },
      )) as unknown as typeof fetch;
    await expect(api.billing.createPortalSession()).rejects.toThrow(
      "Organization billing access is required.",
    );
  });

  it("does not navigate after a billing action becomes stale", async () => {
    let releaseRequest = (_result: { url: string }) => {};
    const request = new Promise<{ url: string }>((resolve) => {
      releaseRequest = resolve;
    });
    let current = true;
    const navigations: string[] = [];
    const redirect = openCurrentBillingSession(
      () => request,
      () => current,
      ({ url }) => navigations.push(url),
    );

    current = false;
    releaseRequest({ url: "https://checkout.stripe.test/stale" });

    expect(await redirect).toBe(false);
    expect(navigations).toEqual([]);
  });
});
