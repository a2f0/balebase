import { describe, expect, it } from "bun:test";
import { installDom } from "../testing/dom";
import { useLinkedOrganization } from "./linkedOrganization";

const { mount, window: dom } = installDom({ url: "http://localhost:5173/" });

function Linked(props: Parameters<typeof useLinkedOrganization>[0]) {
  useLinkedOrganization(props);
  return null;
}

async function open(
  url: string,
  organizations: string[],
  switched: string[],
  activeOrganizationId = "org-1",
) {
  dom.history.replaceState(null, "", url);
  const page = (loaded: string[]) => (
    <Linked
      activeOrganizationId={activeOrganizationId}
      organizations={loaded.map((id) => ({ id }))}
      switchOrganization={async (id) => {
        switched.push(id);
      }}
    />
  );
  // Organizations load after the first render.
  const view = await mount(page([]));
  expect(switched).toEqual([]);
  await view.render(page(organizations));
  return view;
}

describe("linked organizations", () => {
  it("switches to the organization an emailed link names, once", async () => {
    const switched: string[] = [];
    await open(
      "/me/screening/r?organization=org-2#form",
      ["org-1", "org-2"],
      switched,
    );
    expect(switched).toEqual(["org-2"]);
    expect(
      `${dom.location.pathname}${dom.location.search}${dom.location.hash}`,
    ).toBe("/me/screening/r#form");
  });

  it("stays put for the active organization or one the person is not in", async () => {
    for (const [url, active] of [
      ["/organization/people?organization=org-1", "org-1"],
      ["/organization/people?organization=org-9&tab=a", "org-1"],
    ] as const) {
      const switched: string[] = [];
      const view = await open(url, ["org-1", "org-2"], switched, active);
      expect(switched).toEqual([]);
      expect(dom.location.search).not.toContain("organization=");
      await view.unmount();
    }
  });
});
