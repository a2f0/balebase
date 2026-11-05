import { describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import { useWorkspaceOrganizations } from "./useWorkspaceOrganizations";

const { mount, respond } = installDom({ url: "http://localhost:5173/" });

let workspace: ReturnType<typeof useWorkspaceOrganizations> | undefined;

function Probe({ userId }: { userId: string }) {
  workspace = useWorkspaceOrganizations(
    { session: { activeOrganizationId: "org-1" }, user: { id: userId } },
    async () => undefined,
  );
  return null;
}

describe("workspace organizations", () => {
  it("marks the list as read only after it loads, never after a failure", async () => {
    respond(() => Response.json({ error: "Unavailable." }, { status: 503 }));
    const view = await mount(<Probe userId="person" />);
    await act(async () => undefined);
    expect(workspace?.organizations).toEqual([]);
    expect(workspace?.listed).toBe(false);

    respond(() =>
      Response.json({
        organizations: [{ id: "org-1", name: "One", slug: "one" }],
      }),
    );
    await view.render(<Probe userId="someone-else" />);
    await act(async () => undefined);
    expect(workspace?.organizations.map(({ id }) => id)).toEqual(["org-1"]);
    expect(workspace?.listed).toBe(true);

    // Another person's list is not this one's while theirs loads.
    const held = Promise.withResolvers<Response>();
    respond(() => held.promise);
    await view.render(<Probe userId="third" />);
    expect(workspace?.listed).toBe(false);
    await act(async () => held.resolve(Response.json({ organizations: [] })));
    expect(workspace?.listed).toBe(true);
  });
});
