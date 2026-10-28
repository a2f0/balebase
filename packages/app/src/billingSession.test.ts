import { describe, expect, it } from "bun:test";
import { openCurrentBillingSession } from "./billingSession";

describe("billing session", () => {
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
