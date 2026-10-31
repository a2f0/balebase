import { describe, expect, it, setSystemTime } from "bun:test";
import {
  createFixture,
  jsonRequest,
  mockPlaid,
  testApp,
} from "../testing/financeFixture";
import type { Bindings } from "../types";
import { institutionHealthTtlMs } from "./financeInstitutionHealth";
import {
  PlaidApiError,
  type PlaidRequest,
  type PlaidRequestBody,
} from "./plaid";

const institution = {
  institution_id: "ins_test",
  name: "First Test Bank",
  status: {
    item_logins: {
      breakdown: { error_institution: 0.81, error_plaid: 0.02, success: 0.17 },
      last_status_change: "2026-10-31T13:10:00Z",
      status: "DOWN",
    },
    transactions_updates: {
      breakdown: {
        error_institution: 0.01,
        error_plaid: 0,
        refresh_interval: "NORMAL",
        success: 0.99,
      },
      last_status_change: "2026-10-20T08:00:00Z",
      status: "HEALTHY",
    },
  },
};

/** A Plaid stub that records requests and answers institution lookups. */
async function healthFixture() {
  const fixture = await createFixture();
  const plaid = mockPlaid();
  const calls: { body: PlaidRequestBody; path: string }[] = [];
  const state: {
    failure?: PlaidApiError | undefined;
    institution: unknown;
  } = {
    institution,
  };
  const requestPlaid: PlaidRequest = async <T>(
    env: Bindings,
    path: string,
    body: PlaidRequestBody,
  ) => {
    calls.push({ body, path });
    if (path === "/institutions/get_by_id") {
      if (state.failure) throw state.failure;
      return { institution: state.institution, request_id: "req-1" } as T;
    }
    return plaid<T>(env, path, body);
  };
  const app = testApp("org_user-1", requestPlaid);
  async function connect(institutionId?: string) {
    const exchange = await jsonRequest<{ connectionId: string }>(
      app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId,
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    return exchange.body.connectionId;
  }
  const health = <T = unknown>(id: string, organization = app) =>
    jsonRequest<T>(
      organization,
      fixture.bindings,
      `/connections/${id}/institution-health`,
      "GET",
    );
  const lookups = () =>
    calls.filter(({ path }) => path === "/institutions/get_by_id");
  return {
    ...fixture,
    app,
    connect,
    health,
    lookups,
    requestPlaid,
    state,
  };
}

describe("institution health", () => {
  it("reports logins and transaction updates separately, as percentages", async () => {
    const fixture = await healthFixture();
    const id = await fixture.connect("ins_test");
    const response = await fixture.health(id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      checkedAt: expect.any(String),
      institutionId: "ins_test",
      institutionName: "First Test Bank",
      logins: {
        institutionErrorRate: 81,
        lastStatusChange: "2026-10-31T13:10:00Z",
        plaidErrorRate: 2,
        status: "DOWN",
        successRate: 17,
      },
      transactions: {
        institutionErrorRate: 1,
        lastStatusChange: "2026-10-20T08:00:00Z",
        plaidErrorRate: 0,
        refreshInterval: "NORMAL",
        status: "HEALTHY",
        successRate: 99,
      },
    });
    // The application's credentials only: no access token leaves D1.
    expect(fixture.lookups()).toEqual([
      {
        body: {
          country_codes: ["US"],
          institution_id: "ins_test",
          options: { include_status: true },
        },
        path: "/institutions/get_by_id",
      },
    ]);
  });

  it("keeps missing health unknown instead of healthy", async () => {
    const fixture = await healthFixture();
    fixture.state.institution = {
      institution_id: "ins_test",
      status: { item_logins: { breakdown: { success: "n/a" } } },
    };
    const known = await fixture.connect("ins_test");
    expect((await fixture.health(known)).body).toMatchObject({
      logins: {
        institutionErrorRate: null,
        lastStatusChange: null,
        plaidErrorRate: null,
        status: null,
        successRate: null,
      },
      transactions: null,
    });

    const unknown = await fixture.connect();
    expect((await fixture.health(unknown)).body).toMatchObject({
      institutionId: null,
      logins: null,
      transactions: null,
    });
    expect(fixture.lookups()).toHaveLength(1);
  });

  it("refuses unknown and other organizations' connections without asking Plaid", async () => {
    const fixture = await healthFixture();
    const id = await fixture.connect("ins_test");
    const foreign = await fixture.health(
      id,
      testApp("organization-2", fixture.requestPlaid),
    );
    const unknown = await fixture.health("unknown");
    for (const response of [foreign, unknown]) {
      expect(response).toMatchObject({
        body: { error: "Connection not found." },
        status: 404,
      });
    }
    expect(fixture.lookups()).toEqual([]);
  });

  it("reuses one answer per institution for a few minutes, but not a failure", async () => {
    const fixture = await healthFixture();
    const start = new Date("2026-10-31T14:00:00.000Z");
    setSystemTime(start);
    try {
      const first = await fixture.connect("ins_test");
      const second = await fixture.connect("ins_test");
      fixture.state.failure = new PlaidApiError(
        "Plaid is unavailable.",
        "INTERNAL_SERVER_ERROR",
        500,
      );
      expect(await fixture.health(first)).toMatchObject({
        body: { code: "INTERNAL_SERVER_ERROR" },
        status: 502,
      });
      fixture.state.failure = undefined;
      const fresh = await fixture.health<{ checkedAt: string }>(first);
      expect(fresh.body.checkedAt).toBe(start.toISOString());
      setSystemTime(new Date(start.getTime() + institutionHealthTtlMs - 1));
      expect((await fixture.health(second)).body).toEqual(fresh.body);
      expect(fixture.lookups()).toHaveLength(2);

      setSystemTime(new Date(start.getTime() + institutionHealthTtlMs));
      const later = await fixture.health<{ checkedAt: string }>(second);
      expect(later.body.checkedAt).not.toBe(start.toISOString());
      expect(fixture.lookups()).toHaveLength(3);
    } finally {
      setSystemTime();
    }
  });
});
