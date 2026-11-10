import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useState } from "react";
import { installDom } from "../testing/dom";
import { KeptPage } from "./KeptPage";

const {
  click,
  mount,
  window: dom,
} = installDom({
  url: "http://localhost:5173/list",
});

/** The window's scroll position; the DOM lays nothing out, so tests set it. */
let scrolled = 0;
let scrolledTo: number[] = [];
const saved = ["scrollTo", "scrollY"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(dom, key)] as const,
);

beforeEach(() => {
  scrolled = 0;
  scrolledTo = [];
  Object.defineProperty(dom, "scrollY", {
    configurable: true,
    get: () => scrolled,
  });
  Object.defineProperty(dom, "scrollTo", {
    configurable: true,
    value: (_x: number, y: number) => {
      scrolled = y;
      scrolledTo.push(y);
    },
  });
});

afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(dom, key, descriptor);
    else Reflect.deleteProperty(dom, key);
  }
  dom.history.replaceState(null, "", "/list");
});

/**
 * The section at `pathname`, shown by the history entry at `position` as the
 * workspace's navigation tags it; paths under /list/ name records.
 */
function section(pathname: string, position: number) {
  dom.history.replaceState({ workspacePosition: position }, "", pathname);
  return (
    <KeptPage
      page={(path) => <Counter pathname={path} />}
      pathname={pathname}
      record={
        pathname.startsWith("/list/") ? <p>Record {pathname}</p> : undefined
      }
    />
  );
}

function Counter({ pathname }: { pathname: string }) {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount(count + 1)} type="button">
      {pathname} {count}
    </button>
  );
}

function scroll(top: number) {
  scrolled = top;
  dom.dispatchEvent(new dom.Event("scroll"));
}

describe("KeptPage", () => {
  it("returns on Back to the page as it was left, scrolled where it was", async () => {
    const view = await mount(section("/list", 1));
    const counter = () => view.container.querySelector("button");
    await click(counter());
    await click(counter());
    scroll(900);

    await view.render(section("/list/a", 2));
    expect(view.container.textContent).toContain("Record /list/a");
    expect(counter()?.style.display).toBe("none");
    // The shorter record page clamps the scroll after the page is hidden.
    scroll(120);
    await view.render(section("/list/b", 3));
    await view.render(section("/list/a", 2));

    await view.render(section("/list", 1));
    expect(counter()?.style.display).toBe("");
    expect(counter()?.textContent).toBe("/list 2");
    expect(view.container.textContent).not.toContain("Record");
    expect(scrolledTo).toEqual([900]);
  });

  it("starts the page afresh from a link, or when it opened at a record", async () => {
    const view = await mount(section("/list/a", 1));
    const counter = () => view.container.querySelector("button");
    expect(counter()).toBeNull();
    scroll(300);
    await view.render(section("/list", 2));
    expect(counter()?.textContent).toBe("/list 0");
    await click(counter());

    scroll(700);
    await view.render(section("/list/a", 3));
    await view.render(section("/list", 4));
    expect(counter()?.textContent).toBe("/list 0");
    expect(scrolledTo).toEqual([]);
  });
});
