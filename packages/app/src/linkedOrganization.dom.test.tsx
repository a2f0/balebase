import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useLinkedOrganization } from "./linkedOrganization";

const dom = new Window({ url: "http://localhost:5173/" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

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
  const render = (loaded: string[]) =>
    root?.render(
      <Linked
        activeOrganizationId={activeOrganizationId}
        organizations={loaded.map((id) => ({ id }))}
        switchOrganization={async (id) => {
          switched.push(id);
        }}
      />,
    );
  root = createRoot(document.createElement("div"));
  // Organizations load after the first render.
  await act(async () => render([]));
  expect(switched).toEqual([]);
  await act(async () => render(organizations));
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
      await open(url, ["org-1", "org-2"], switched, active);
      expect(switched).toEqual([]);
      expect(dom.location.search).not.toContain("organization=");
      if (root) await act(async () => root?.unmount());
      root = undefined;
    }
  });
});
