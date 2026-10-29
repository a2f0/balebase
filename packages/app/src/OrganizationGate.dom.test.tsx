import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { BillingStatus } from "@balebase/validators/billing";
import { act, useState } from "react";
import { installDom } from "./testing/dom";

const {
  clickLink,
  mount,
  respond,
  settle,
  window: dom,
} = installDom({ url: "http://localhost:5173/" });
let Workspace: (props: { initialPath: string }) => React.JSX.Element;
let container: HTMLElement;

const freeStatus: BillingStatus = {
  billing: { cancelAtPeriodEnd: false, currentPeriodEnd: null, status: null },
  canManage: true,
  current: { formTemplates: 0, members: 2 },
  limits: { formTemplates: 5, retentionDays: 30, users: 1 },
  plan: "free",
  pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
  seats: 1,
};

beforeAll(async () => {
  const { OrganizationGate } = await import("./OrganizationGate");
  const { OrganizationBilling } = await import("./OrganizationBilling");
  const { useOrganizationAccess } = await import("./useOrganizationAccess");
  // The workspace wiring from App: the real access hook gates each page, and
  // Billing refreshes that access after Checkout, as OrganizationSettings does.
  Workspace = function Workspace({ initialPath }: { initialPath: string }) {
    const [pathname, setPathname] = useState(initialPath);
    const access = useOrganizationAccess("user-1", "org-1");
    if (access.isPending) return <p>Loading workspace</p>;
    return (
      <>
        <nav>
          <button onClick={() => setPathname("/audits")} type="button">
            Audits
          </button>
        </nav>
        <OrganizationGate
          access={access}
          navigate={setPathname}
          pathname={pathname}
          signOut={async () => {}}
        >
          {pathname === "/organization/billing" ? (
            <OrganizationBilling
              onPlanChanged={access.refresh}
              organizationId="org-1"
            />
          ) : (
            <p>Audits page</p>
          )}
        </OrganizationGate>
      </>
    );
  };
});

afterEach(() => {
  dom.history.replaceState(null, "", "/");
});

/** Serves the API; a confirmed Checkout gives the user a seat. */
function serveApi(seatCode: "SEAT_UNAVAILABLE" | "UPGRADE_REQUIRED") {
  const requests: string[] = [];
  let paid = false;
  respond(async (url) => {
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/organization-groups/access")) {
      return paid
        ? Response.json({
            capabilities: [],
            memberRole: "owner",
            ownerCount: 2,
          })
        : Response.json(
            {
              code: seatCode,
              error: "This organization's Free plan includes one user.",
            },
            { status: 403 },
          );
    }
    if (url.searchParams.get("session_id") === "cs_paid") {
      paid = true;
      return Response.json({
        ...freeStatus,
        checkout: "complete",
        plan: "pro",
      });
    }
    return Response.json(freeStatus);
  });
  return requests;
}

async function render(initialPath: string) {
  ({ container } = await mount(<Workspace initialPath={initialPath} />));
  await settle();
}

function link(name: string) {
  return [...container.querySelectorAll("a")].find(
    (element) => element.textContent === name,
  );
}

async function click(element: Element | undefined) {
  if (!element) throw new Error("Nothing to click.");
  await act(async () => {
    clickLink(element);
  });
  await settle();
}

describe("organization seat gate", () => {
  it("sends an unseated owner to Billing and lifts the gate after Checkout", async () => {
    const requests = serveApi("UPGRADE_REQUIRED");
    await render("/audits");
    expect(container.textContent).toContain(
      "Upgrade to Pro to restore your access",
    );
    expect(container.textContent).not.toContain("Audits page");

    // Stripe returns here; Billing confirms after access already loaded.
    dom.history.replaceState(
      null,
      "",
      "/audits?checkout=success&session_id=cs_paid",
    );
    await click(link("Go to Billing"));
    expect(container.textContent).toContain("Your Pro subscription is active.");
    expect(requests.filter((path) => path.endsWith("/access"))).toHaveLength(2);

    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Audits",
      ),
    );
    expect(container.textContent).toContain("Audits page");
    expect(container.textContent).not.toContain("Upgrade required");
  });

  it("keeps members without a seat out of Billing too", async () => {
    serveApi("SEAT_UNAVAILABLE");
    await render("/organization/billing");
    expect(container.textContent).toContain("Ask an owner to upgrade to Pro");
    expect(link("Go to Billing")).toBeUndefined();
    expect(container.textContent).not.toContain("Current plan");
  });
});
