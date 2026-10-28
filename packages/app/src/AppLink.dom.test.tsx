import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { AppButtonLink, AppLink } from "./AppLink";

const dom = new Window({ url: "http://localhost:5173/" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

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
  container?.remove();
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

async function render(element: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  const link = container.querySelector<HTMLAnchorElement>("a");
  if (!link) throw new Error("No link rendered.");
  return link;
}

/** Clicks the link and reports whether the app took over the click. */
function click(
  link: HTMLAnchorElement,
  init: {
    altKey?: boolean;
    button?: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  } = {},
) {
  const event = new dom.MouseEvent("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
    ...init,
  });
  link.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
}

const browserClicks = [
  { metaKey: true },
  { ctrlKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
];

describe("app links", () => {
  it("opens a plain click in place and leaves other clicks to the browser", async () => {
    const paths: string[] = [];
    const link = await render(
      <AppLink
        aria-current="page"
        className="tab"
        href="/equipment/item%2F1"
        onNavigate={(path) => paths.push(path)}
      >
        Laptop
      </AppLink>,
    );
    expect(link.getAttribute("href")).toBe("/equipment/item%2F1");
    expect(link.className).toBe("tab");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.textContent).toBe("Laptop");

    for (const init of browserClicks) {
      expect([init, click(link, init)]).toEqual([init, false]);
    }
    expect(paths).toEqual([]);

    expect(click(link)).toBe(true);
    expect(paths).toEqual(["/equipment/item%2F1"]);
  });

  it("follows button-styled links the same way", async () => {
    const paths: string[] = [];
    const link = await render(
      <AppButtonLink
        href="/me"
        icon="arrowLeft"
        onNavigate={(path) => paths.push(path)}
        size="sm"
        variant="ghost"
      >
        Back
      </AppButtonLink>,
    );
    expect(link.getAttribute("href")).toBe("/me");
    expect(link.classList.contains("button")).toBe(true);
    expect(link.classList.contains("buttonSm")).toBe(true);

    for (const init of browserClicks) {
      expect(click(link, init)).toBe(false);
    }
    expect(click(link)).toBe(true);
    expect(paths).toEqual(["/me"]);
  });
});
