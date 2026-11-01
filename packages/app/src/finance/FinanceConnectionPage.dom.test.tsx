import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { ActivityPage } from "@balebase/validators/activity";
import type {
  FinanceConnectionDetail,
  FinanceInstitutionHealth,
} from "@balebase/validators/finance";
import { act } from "react";
import { holdTimers, installDom } from "../testing/dom";
import { FinanceConnectionPage } from "./FinanceConnectionPage";
import { syncPollMs } from "./financeConnectionActions";

const { button, click, mount, respond, settle, stubClipboard } = installDom({
  url: "http://localhost:5173/finance/connections/item-1",
});
let container: HTMLElement;

function detail(
  connection: Partial<FinanceConnectionDetail["connection"]> = {},
): FinanceConnectionDetail {
  return {
    accounts: [
      {
        availableBalance: 1200,
        currencyCode: "USD",
        currentBalance: 1250.5,
        id: "account-1",
        mask: "1234",
        name: "Checking",
        officialName: "Plaid Gold Checking",
        plaidAccountId: "plaid-account-1",
        subtype: "checking",
        transactionCount: 42,
        type: "depository",
      },
    ],
    connection: {
      dailySync: false,
      syncJob: null,
      createdAt: "2026-09-01T12:00:00.000Z",
      createdBy: { email: "person@example.com", name: "Example Person" },
      disconnectedAt: null,
      errorCode: null,
      errorMessage: null,
      id: "item-1",
      institutionId: "ins_109508",
      institutionName: "First Platypus Bank",
      lastSyncedAt: "2026-10-18T12:00:00.000Z",
      plaidItemId: "plaid-item-1",
      status: "active",
      transactions: {
        count: 42,
        firstDate: "2025-01-03",
        lastDate: "2026-10-17",
      },
      ...connection,
    },
  };
}

function health(
  logins: Partial<NonNullable<FinanceInstitutionHealth["logins"]>> | null = {},
): FinanceInstitutionHealth {
  return {
    checkedAt: "2026-10-31T14:00:00.000Z",
    institutionId: "ins_109508",
    institutionName: "First Platypus Bank",
    logins: logins && {
      institutionErrorRate: 0.5,
      lastStatusChange: "2026-10-01T08:00:00.000Z",
      plaidErrorRate: 0.1,
      status: "HEALTHY",
      successRate: 99.4,
      ...logins,
    },
    transactions: null,
  };
}

/** The connection's own history: who connected it. */
function history(): ActivityPage {
  return {
    events: [
      {
        action: "finance.connection_created",
        actor: {
          apiKey: null,
          email: "person@example.com",
          id: "user-1",
          name: "Example Person",
          source: null,
          type: "user",
        },
        details: {
          institutionId: "ins_109508",
          institutionName: "First Platypus Bank",
        },
        historical: false,
        id: 1,
        occurredAt: "2026-09-01T12:00:00.000Z",
        root: {
          id: "item-1",
          label: "First Platypus Bank",
          type: "finance_connection",
        },
        subject: { id: "item-1", type: "finance_connection" },
      },
    ],
    nextCursor: null,
  };
}

async function mountPage(onNavigate: (path: string) => void = () => undefined) {
  const view = await mount(
    <>
      <FinanceConnectionPage id="item-1" onNavigate={onNavigate} />
      <DialogHost />
    </>,
  );
  container = view.container;
  await settle();
  return view;
}

/** Answers the open dialog with the button labelled `label`. */
async function answer(label: string) {
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) throw new Error("No open dialog");
  await click(button(label, dialog));
}

describe("Finance connection page", () => {
  it("shows the connection, its accounts, and copyable Plaid identifiers", async () => {
    const copied: string[] = [];
    stubClipboard(async (text) => void copied.push(text));
    const requests: string[] = [];
    respond(async (url) => {
      requests.push(url.pathname);
      return Response.json(
        url.pathname.endsWith("/activity") ? history() : detail(),
      );
    });
    await mountPage();

    expect(requests).toEqual([
      "/api/finance/connections/item-1",
      "/api/finance/connections/item-1/activity",
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Example Person connected a bank");
    expect(text).toContain("First Platypus Bank");
    expect(text).toContain("by Example Person");
    expect(text).toContain("42 transactions");
    expect(text).toContain("Plaid Gold Checking");
    expect(text).toContain("plaid-item-1");
    expect(text).not.toContain("Last error");
    expect(text).toContain("42 transactions · ");
    const account = container.querySelector<HTMLAnchorElement>(
      ".rowTarget[href='/finance/accounts/account-1']",
    );
    expect(account?.textContent).toBe("Checking");
    await click("Copy Plaid Item ID");
    await click("Copy Plaid account ID · Checking ••1234");
    await click("Copy Plaid institution ID");
    expect(copied).toEqual(["plaid-item-1", "plaid-account-1", "ins_109508"]);
    expect(document.body.textContent).toContain("Plaid institution ID copied.");
    expect(() => button("Copy Institution")).toThrow();
  });

  it("reloads after a failed sync to show Plaid's error", async () => {
    let failed = false;
    respond(async (url, init) => {
      if (init?.method === "POST") {
        failed = true;
        return Response.json(
          {
            code: "ITEM_LOGIN_REQUIRED",
            error: "The login details of this item have changed.",
          },
          { status: 502 },
        );
      }
      if (url.href.endsWith("/institution-health"))
        return Response.json(health());
      return Response.json(
        failed
          ? detail({
              errorCode: "ITEM_LOGIN_REQUIRED",
              errorMessage: "The login details of this item have changed.",
              status: "error",
            })
          : detail(),
      );
    });
    await mountPage();
    await click("Sync now");
    const text = container.textContent ?? "";
    expect(text).toContain("The login details of this item have changed.");
    expect(text).toContain("Last error");
    expect(text).toContain("ITEM_LOGIN_REQUIRED");
    expect(button("Sync now").disabled).toBe(false);
  });

  it("deletes a disconnected connection's data and returns to Connections", async () => {
    const deletes: string[] = [];
    respond(async (url, init) => {
      if (init?.method === "DELETE") {
        deletes.push(url.href);
        return new Response(null, { status: 204 });
      }
      return Response.json(
        detail({
          disconnectedAt: "2026-10-19T09:00:00.000Z",
          status: "disconnected",
        }),
      );
    });
    const paths: string[] = [];
    await mountPage((path) => paths.push(path));
    expect(() => button("Sync now")).toThrow();
    expect(container.textContent).toContain("Disconnected");
    expect(container.textContent).not.toContain("Bank status");

    await click("Delete data");
    await answer("Cancel");
    expect(deletes).toEqual([]);
    await click("Delete data");
    await answer("Delete data");
    expect(deletes).toEqual([
      expect.stringContaining("/api/finance/connections/item-1/data"),
    ]);
    expect(paths).toEqual(["/finance/connections"]);
  });
});

it("keeps an accepted sync visible after navigation and polls its saved outcome", async () => {
  using polls = holdTimers(syncPollMs);
  const job = {
    id: "sync-1",
    status: "queued" as "queued" | "running" | "succeeded",
    source: "manual",
    added: 0,
    modified: 0,
    removed: 0,
    createdAt: "2026-10-26T12:00:00Z",
    finishedAt: null,
    errorCode: null,
  } as const;
  let requested = false;
  let finished = false;
  let starts = 0;
  let statusRequests = 0;
  let detailRequests = 0;
  respond(async (url, init) => {
    if (init?.method === "POST") {
      expect(url.href).toEndWith("/connections/item-1/sync-jobs");
      requested = true;
      starts++;
      return Response.json(job, { status: 202 });
    }
    if (url.href.endsWith("/sync-status")) statusRequests++;
    else detailRequests++;
    return Response.json(
      detail({
        syncJob: requested
          ? {
              ...job,
              status: finished ? "succeeded" : "running",
              added: finished ? 7 : 0,
              finishedAt: finished ? "2026-10-26T12:01:00Z" : null,
            }
          : null,
      }),
    );
  });
  const first = await mountPage();
  await click("Sync now");
  expect(container.textContent).toContain("You can leave this page");
  expect(button("Syncing…").disabled).toBe(true);
  await first.unmount();
  container.remove();
  await mountPage();
  expect(container.textContent).toContain("Running");
  const loaded = detailRequests;
  await polls.fire();
  expect(statusRequests).toBe(1);
  expect(detailRequests).toBe(loaded);
  finished = true;
  await polls.fire();
  expect(container.textContent).toContain("Succeeded · 7 added");
  expect(button("Sync now").disabled).toBe(false);
  expect(starts).toBe(1);
});

it("saves daily sync for the bank connection and preserves the setting on a failed save", async () => {
  let enabled = false;
  let fail = false;
  respond(async (url, init) => {
    if (init?.method === "PATCH") {
      expect(url.href).toEndWith("/connections/item-1/sync-settings");
      if (fail)
        return Response.json(
          { error: "Could not save sync settings." },
          { status: 503 },
        );
      enabled = JSON.parse(String(init.body)).dailySync;
      return Response.json({ dailySync: enabled });
    }
    return Response.json(detail({ dailySync: enabled }));
  });
  await mountPage();
  const checkbox = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!checkbox) throw new Error("Daily sync checkbox missing");
  expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click());
  await settle();
  expect(enabled).toBe(true);
  expect(checkbox.checked).toBe(true);
  fail = true;
  await act(async () => checkbox.click());
  await settle();
  expect(checkbox.checked).toBe(true);
  expect(container.textContent).toContain("Could not save sync settings.");
});

describe("Bank status", () => {
  it("checks for an outage only when asked while the connection works", async () => {
    const requests: string[] = [];
    respond(async (url) => {
      if (url.pathname.endsWith("/activity")) return Response.json(history());
      requests.push(url.pathname);
      return Response.json(
        url.pathname.endsWith("/institution-health") ? health() : detail(),
      );
    });
    await mountPage();
    expect(requests).toEqual(["/api/finance/connections/item-1"]);
    expect(container.textContent).toContain(
      "check whether First Platypus Bank is having a wider outage",
    );

    await click("Check for outages");
    expect(requests).toEqual([
      "/api/finance/connections/item-1",
      "/api/finance/connections/item-1/institution-health",
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Logins and repairs");
    expect(text).toContain("Healthy 99.4% of recent requests succeeded");
    expect(text).toContain("0.5% failed at the bank, 0.1% failed at Plaid");
    expect(text).toContain("Transaction updates");
    expect(text).toContain("Unknown Plaid did not report it.");
    expect(container.querySelector(".banner")).toBeNull();
    expect(button("Check again").disabled).toBe(false);
  });

  it("checks by itself when the connection fails and warns during a login outage", async () => {
    respond(async (url) =>
      Response.json(
        url.pathname.endsWith("/institution-health")
          ? health({
              institutionErrorRate: 81,
              plaidErrorRate: 2,
              status: "DOWN",
              successRate: 17,
            })
          : detail({ errorCode: "ITEM_LOGIN_REQUIRED", status: "error" }),
      ),
    );
    await mountPage();
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Plaid reports that logins at First Platypus Bank are failing for many people.",
    );
    expect(text).toContain("Down 17% of recent requests succeeded");
    expect(text).toContain("81% failed at the bank");
  });

  it("points a failing connection at Update login when its bank's logins work", async () => {
    respond(async (url) =>
      Response.json(
        url.pathname.endsWith("/institution-health")
          ? {
              ...health(),
              transactions: {
                institutionErrorRate: 40,
                lastStatusChange: null,
                plaidErrorRate: 0,
                refreshInterval: "DELAYED",
                status: "DEGRADED",
                successRate: 60,
              },
            }
          : detail({ errorCode: "ITEM_LOGIN_REQUIRED", status: "error" }),
      ),
    );
    const paths: string[] = [];
    await mountPage((path) => paths.push(path));
    expect(container.textContent).toContain(
      "this connection probably needs its own login updated",
    );
    // A transaction-refresh problem does not hide the login advice.
    expect(container.textContent).toContain(
      "Plaid reports problems refreshing transactions at First Platypus Bank",
    );
    expect(container.textContent).toContain("Refreshes delayed");
    const link = container.querySelector<HTMLAnchorElement>(
      ".banner a[href='/finance/connections']",
    );
    if (!link) throw new Error("Connections link missing");
    await click(link);
    expect(paths).toEqual(["/finance/connections"]);
  });

  it("does not suggest Update login for a failure a new login cannot fix", async () => {
    respond(async (url) =>
      Response.json(
        url.pathname.endsWith("/institution-health")
          ? health()
          : detail({ errorCode: "INTERNAL_SERVER_ERROR", status: "error" }),
      ),
    );
    await mountPage();
    const text = container.textContent ?? "";
    expect(text).toContain("Healthy 99.4% of recent requests succeeded");
    expect(text).not.toContain("needs its own login updated");
    expect(container.querySelector(".banner")).toBeNull();
  });

  it("says unknown health is unknown and shows a failed check", async () => {
    let fail = true;
    respond(async (url) => {
      if (!url.pathname.endsWith("/institution-health"))
        return Response.json(detail());
      if (fail)
        return Response.json(
          { code: "INTERNAL_SERVER_ERROR", error: "Plaid is unavailable." },
          { status: 502 },
        );
      return Response.json(health(null));
    });
    await mountPage();
    await click("Check for outages");
    expect(container.textContent).toContain("Plaid is unavailable.");
    fail = false;
    await click("Check for outages");
    const text = container.textContent ?? "";
    expect(text).not.toContain("Plaid is unavailable.");
    expect(text).toContain(
      "Plaid did not report login status for First Platypus Bank right now. That does not mean it is working.",
    );
    expect(text).not.toContain("Healthy");
  });
});
