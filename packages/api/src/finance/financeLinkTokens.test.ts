import { describe, expect, it, spyOn } from "bun:test";
import {
  createFixture,
  financePath,
  jsonRequest,
  mockPlaid,
  testApp,
} from "../testing/financeFixture";
import type { Bindings } from "../types";
import {
  PlaidApiError,
  type PlaidRequest,
  type PlaidRequestBody,
} from "./plaid";

interface ConnectionDetail {
  connection: {
    errorCode: string | null;
    plaidItemId: string;
    status: string;
    transactions: { count: number };
  };
}

/** A Plaid stub that records requests and can fail syncs as Axos did. */
async function brokenLoginFixture() {
  const fixture = await createFixture();
  const plaid = mockPlaid();
  const calls: { body: PlaidRequestBody; path: string }[] = [];
  const state = { loginRequired: false };
  const requestPlaid: PlaidRequest = async <T>(
    env: Bindings,
    path: string,
    body: PlaidRequestBody,
  ) => {
    calls.push({ body, path });
    if (state.loginRequired && path === "/transactions/sync") {
      throw new PlaidApiError(
        "The login details of this item have changed.",
        "ITEM_LOGIN_REQUIRED",
        400,
      );
    }
    return plaid<T>(env, path, body);
  };
  const app = testApp("org_user-1", requestPlaid);
  const exchange = await jsonRequest<{ connectionId: string }>(
    app,
    fixture.bindings,
    "/exchange",
    "POST",
    {
      institutionId: "ins_test",
      institutionName: "First Test Bank",
      publicToken: "public-sandbox-test",
    },
  );
  const id = exchange.body.connectionId;
  const request = <T = unknown>(path: string, method = "GET") =>
    jsonRequest<T>(app, fixture.bindings, `/connections/${id}${path}`, method);
  return { ...fixture, app, calls, id, request, requestPlaid, state };
}

describe("Plaid Link update mode", () => {
  it("repairs a login on the same Item and resumes from its sync cursor", async () => {
    const fixture = await brokenLoginFixture();
    expect((await fixture.request("/sync", "POST")).status).toBe(200);
    fixture.state.loginRequired = true;
    expect((await fixture.request("/sync", "POST")).status).toBe(502);
    expect(
      (await fixture.request<ConnectionDetail>("")).body.connection,
    ).toMatchObject({ errorCode: "ITEM_LOGIN_REQUIRED", status: "error" });

    fixture.calls.length = 0;
    const token = await fixture.request("/link-token", "POST");
    expect(token).toMatchObject({
      body: {
        expiration: "2026-08-19T12:30:00Z",
        linkToken: "link-sandbox-test",
      },
      status: 200,
    });
    expect(fixture.calls).toEqual([
      {
        body: {
          access_token: "access-sandbox-test-1",
          client_name: expect.any(String),
          country_codes: ["US"],
          language: "en",
          redirect_uri: "https://app.test/finance",
          user: { client_user_id: "org_user-1:user-1" },
        },
        path: "/link/token/create",
      },
    ]);

    // Link's onSuccess needs no exchange: the next sync uses the same Item.
    fixture.state.loginRequired = false;
    fixture.calls.length = 0;
    expect((await fixture.request("/sync", "POST")).status).toBe(200);
    expect(fixture.calls).toMatchObject([
      {
        body: { access_token: "access-sandbox-test-1", cursor: "cursor-test" },
        path: "/transactions/sync",
      },
    ]);
    expect(
      (await fixture.request<ConnectionDetail>("")).body.connection,
    ).toMatchObject({
      errorCode: null,
      plaidItemId: "item-sandbox-test-1",
      status: "active",
      transactions: { count: 1 },
    });
    expect(
      fixture.database.query("SELECT count(*) AS count FROM plaid_items").get(),
    ).toEqual({ count: 1 });
  });

  it("refuses connections that are disconnected or belong to another organization", async () => {
    const fixture = await brokenLoginFixture();
    const foreign = await jsonRequest(
      testApp("organization-2", fixture.requestPlaid),
      fixture.bindings,
      `/connections/${fixture.id}/link-token`,
      "POST",
    );
    const unknown = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/connections/unknown/link-token",
      "POST",
    );
    const disconnected = await fixture.app.request(
      financePath(`/connections/${fixture.id}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnected.status).toBe(204);
    const afterDisconnect = await fixture.request("/link-token", "POST");
    for (const response of [foreign, unknown, afterDisconnect]) {
      expect(response).toMatchObject({
        body: { error: "Connection not found or disconnected." },
        status: 404,
      });
    }
    expect(
      fixture.calls.filter(({ path }) => path === "/link/token/create"),
    ).toEqual([]);
  });

  it("logs Link diagnostics without storing them and rejects malformed reports", async () => {
    const fixture = await brokenLoginFixture();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const report = {
        connectionId: fixture.id,
        error: {
          displayMessage: null,
          errorCode: "INTERNAL_SERVER_ERROR",
          errorMessage: "an unexpected error occurred",
          errorType: "API_ERROR",
        },
        events: [],
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        linkSessionId: "session-1",
        mode: "update",
        oauthResume: true,
        outcome: "exit",
        requestId: "request-1",
        status: null,
      };
      const accepted = await fixture.app.request(
        financePath("/link-diagnostics"),
        {
          body: JSON.stringify(report),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
        fixture.bindings,
      );
      expect(accepted.status).toBe(204);
      expect(logged).toHaveBeenCalledWith({
        event: "plaid_link_diagnostics",
        organizationId: "org_user-1",
        userId: "user-1",
        ...report,
      });
      const rejected = await jsonRequest(
        fixture.app,
        fixture.bindings,
        "/link-diagnostics",
        "POST",
        { ...report, events: "none" },
      );
      expect(rejected).toMatchObject({
        body: { error: "Invalid Plaid Link diagnostics." },
        status: 400,
      });
    } finally {
      logged.mockRestore();
    }
  });
});
