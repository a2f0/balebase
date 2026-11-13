import { describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import { useOrganizationAccess } from "./useOrganizationAccess";

const { mount, respond } = installDom({ url: "http://localhost:5173/" });

let access: ReturnType<typeof useOrganizationAccess> | undefined;
const seen: { can: boolean; confirmed: boolean }[] = [];

function Probe() {
  access = useOrganizationAccess("person", "org");
  seen.push({ can: access.can("finance"), confirmed: access.confirmed });
  return null;
}

function FinanceNavigation() {
  access = useOrganizationAccess("person", "org");
  return access.can("finance") ? (
    <a href="/finance">Finance</a>
  ) : (
    <p>Finance unavailable</p>
  );
}

describe("organization access", () => {
  it("confirms the server's answer, refusals included, but never a failure to read it", async () => {
    respond(() => Response.json({ error: "Unavailable." }, { status: 503 }));
    await mount(<Probe />);
    expect(access?.confirmed).toBe(false);
    expect(access?.can("finance")).toBe(false);

    // A retry after a failure never passes through a confirmed empty state.
    const answer = Promise.withResolvers<void>();
    respond(async () => {
      await answer.promise;
      return Response.json({
        capabilities: ["finance"],
        memberRole: "member",
        ownerCount: 1,
        paidFeaturesEnabled: true,
      });
    });
    seen.length = 0;
    await act(async () => {
      const retry = access?.refresh();
      answer.resolve();
      await retry;
    });
    expect(seen.filter(({ can, confirmed }) => confirmed && !can)).toEqual([]);
    expect(access?.confirmed).toBe(true);
    expect(access?.can("finance")).toBe(true);

    // Removed from the organization: the server refuses.
    respond(() => Response.json({ error: "Not a member." }, { status: 403 }));
    await act(async () => access?.refresh());
    expect(access?.confirmed).toBe(true);
    expect(access?.can("finance")).toBe(false);
  });

  it("gates Finance by both the paid setting and existing group permissions", async () => {
    let paidFeaturesEnabled = false;
    let capabilities: string[] = ["finance"];
    respond(() =>
      Response.json({
        capabilities,
        memberRole: "owner",
        ownerCount: 1,
        paidFeaturesEnabled,
      }),
    );
    const view = await mount(<FinanceNavigation />);
    expect(view.container.textContent).toBe("Finance unavailable");
    paidFeaturesEnabled = true;
    await act(async () => access?.refresh());
    expect(view.container.querySelector("a")?.textContent).toBe("Finance");
    capabilities = [];
    await act(async () => access?.refresh());
    expect(view.container.textContent).toBe("Finance unavailable");
  });
});
