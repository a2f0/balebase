import { beforeEach, describe, expect, it } from "bun:test";
import type {
  FinanceConnection,
  FinanceData,
} from "@balebase/validators/finance";
import { act } from "react";
import { installDom } from "../testing/dom";
import { Finance } from "./Finance";

const {
  mount,
  respond,
  window: dom,
} = installDom({
  url: "http://localhost:5173/finance/connections",
  globals: (window) => ({ localStorage: window.localStorage }),
});

const broken: FinanceConnection = {
  accountCount: 4,
  createdAt: "2026-10-17T17:26:46.998Z",
  dailySync: true,
  errorCode: "ITEM_LOGIN_REQUIRED",
  id: "axos",
  institutionId: "ins_138430",
  institutionName: "Axos Bank - Personal",
  lastSyncedAt: "2026-10-27T00:01:01.686Z",
  status: "error",
  syncStatus: "failed",
};
const data: FinanceData = {
  accounts: [],
  categories: [],
  configured: true,
  connections: [broken],
  nextCursor: null,
  transactions: [],
};

const marker = "balebase.plaid.updateConnection";
type PlaidConfig = Parameters<NonNullable<Window["Plaid"]>["create"]>[0];
let container: HTMLElement;
let opened: PlaidConfig[];
let requests: string[];

beforeEach(() => {
  opened = [];
  requests = [];
  dom.localStorage.clear();
  dom.history.replaceState(null, "", "/finance/connections");
  Object.assign(dom, {
    Plaid: {
      create: (config: PlaidConfig) => {
        opened.push(config);
        return { destroy() {}, exit() {}, open() {} };
      },
    },
  });
  respond((url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") requests.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/link-token"))
      return Response.json({
        expiration: "2026-10-30T12:00:00Z",
        linkToken: url.pathname.includes("/connections/")
          ? "link-update"
          : "link-new",
      });
    if (url.pathname === "/api/finance/exchange")
      return Response.json({ connectionId: "new" }, { status: 201 });
    if (url.pathname.endsWith("/sync-jobs"))
      return Response.json(
        {
          added: 0,
          createdAt: "2026-10-30T12:00:00.000Z",
          errorCode: null,
          finishedAt: null,
          id: "job",
          modified: 0,
          removed: 0,
          source: "manual",
          status: "queued",
        },
        { status: 202 },
      );
    return Response.json(data);
  });
});

async function mountConnections() {
  ({ container } = await mount(
    <Finance onNavigate={() => {}} pathname="/finance/connections" />,
  ));
}

async function click(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  await act(async () => match.click());
}

async function succeed(config: PlaidConfig | undefined) {
  if (!config) throw new Error("Plaid Link did not open.");
  await act(async () =>
    config.onSuccess("public-token", {
      institution: { institution_id: "ins_138430", name: "Axos" },
    }),
  );
}

describe("Plaid Link", () => {
  it("updates a broken login in place: syncs the same connection without an exchange", async () => {
    await mountConnections();
    await click("Update login");
    expect(opened.map(({ token }) => token)).toEqual(["link-update"]);
    await succeed(opened[0]);
    expect(requests).toEqual([
      "POST /api/finance/connections/axos/link-token",
      "POST /api/finance/connections/axos/sync-jobs",
    ]);
    expect(dom.localStorage.length).toBe(0);
  });

  it("keeps a new connection when another tab starts an update meanwhile", async () => {
    await mountConnections();
    await click("Connect bank");
    // Another tab opens update mode for Axos before this Link session ends.
    dom.localStorage.setItem(
      marker,
      JSON.stringify({ connectionId: "axos", linkToken: "link-other-tab" }),
    );
    dom.localStorage.setItem("balebase.plaid.linkToken", "link-other-tab");
    await succeed(opened[0]);
    expect(requests).toEqual([
      "POST /api/finance/link-token",
      "POST /api/finance/exchange",
      "POST /api/finance/connections/new/sync-jobs",
    ]);
  });

  it("exchanges after an OAuth redirect when the update marker belongs to another link token", async () => {
    dom.localStorage.setItem("balebase.plaid.linkToken", "link-new");
    dom.localStorage.setItem(
      marker,
      JSON.stringify({ connectionId: "axos", linkToken: "link-update" }),
    );
    dom.history.replaceState(null, "", "/finance?oauth_state_id=state");
    await mountConnections();
    await succeed(opened[0]);
    expect(requests).toEqual([
      "POST /api/finance/exchange",
      "POST /api/finance/connections/new/sync-jobs",
    ]);
  });

  it("finishes an update after an OAuth redirect without exchanging a token", async () => {
    dom.localStorage.setItem("balebase.plaid.linkToken", "link-update");
    dom.localStorage.setItem(
      marker,
      JSON.stringify({ connectionId: "axos", linkToken: "link-update" }),
    );
    dom.history.replaceState(null, "", "/finance?oauth_state_id=state");
    await mountConnections();
    expect(opened.map(({ token }) => token)).toEqual(["link-update"]);
    expect(opened[0]?.receivedRedirectUri).toContain("oauth_state_id=state");
    await succeed(opened[0]);
    expect(requests).toEqual(["POST /api/finance/connections/axos/sync-jobs"]);
    expect(dom.localStorage.length).toBe(0);
  });
});
