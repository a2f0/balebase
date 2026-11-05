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
      });
    });
    seen.length = 0;
    const retry = act(async () => access?.refresh());
    await act(async () => answer.resolve());
    await retry;
    expect(seen.filter(({ can, confirmed }) => confirmed && !can)).toEqual([]);
    expect(access?.confirmed).toBe(true);
    expect(access?.can("finance")).toBe(true);

    // Removed from the organization: the server refuses.
    respond(() => Response.json({ error: "Not a member." }, { status: 403 }));
    await act(async () => access?.refresh());
    expect(access?.confirmed).toBe(true);
    expect(access?.can("finance")).toBe(false);
  });
});
