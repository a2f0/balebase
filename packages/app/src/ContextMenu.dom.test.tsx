import { describe, expect, it } from "bun:test";
import { ContextMenu } from "@balebase/ui/react";
import { act } from "react";
import { installDom } from "./testing/dom";

const { mount, window: dom } = installDom({ url: "http://localhost:5173" });
let container: HTMLElement;

async function mountMenu() {
  const selected: string[] = [];
  const { unmount, ...view } = await mount(
    <>
      <ContextMenu
        label="Record actions"
        items={[
          {
            id: "first",
            label: "First",
            onSelect: () => {
              selected.push("first");
            },
          },
          {
            disabled: true,
            id: "disabled",
            label: "Disabled",
            onSelect: () => {
              selected.push("disabled");
            },
          },
          {
            id: "last",
            label: "Last",
            onSelect: () => {
              selected.push("last");
            },
          },
        ]}
      >
        {(props) => (
          <section {...props}>
            <a href="/record">Record</a>
            <button type="button">
              Control
              <svg aria-hidden="true">
                <path d="M0 0h10v10" />
              </svg>
            </button>
            <input aria-label="Name" />
          </section>
        )}
      </ContextMenu>
      <button className="outsideControl" type="button">
        Outside
      </button>
    </>,
  );
  container = view.container;
  return {
    input: container.querySelector<HTMLInputElement>("input"),
    link: container.querySelector<HTMLAnchorElement>("a"),
    control: container.querySelector<HTMLButtonElement>("section button"),
    icon: container.querySelector<SVGElement>("svg path"),
    outside: container.querySelector<HTMLButtonElement>(".outsideControl"),
    selected,
    unmount,
  };
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
];

async function contextClick(element: Element | null, x = 120, y = 180) {
  const event = new dom.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: x,
    clientY: y,
  });
  await act(async () => element?.dispatchEvent(event as never));
  return event;
}

async function key(element: Element | null, value: string, shiftKey = false) {
  const event = new dom.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
    shiftKey,
  });
  await act(async () => element?.dispatchEvent(event as never));
  return event;
}

describe("shared context menu", () => {
  it("restores focus to the control when opened from its SVG icon", async () => {
    const view = await mountMenu();
    await contextClick(view.icon);
    expect(menu()).not.toBeNull();
    await key(document.activeElement, "Escape");
    expect(document.activeElement).toBe(view.control);
  });
  it("opens at the pointer in a portal and focuses the first action", async () => {
    const view = await mountMenu();
    const event = await contextClick(view.link);
    expect(event.defaultPrevented).toBe(true);
    expect(menu()?.parentElement).toBe(document.body);
    expect(menu()?.style.left).toBe("120px");
    expect(menu()?.style.top).toBe("180px");
    expect(document.activeElement).toBe(items()[0] ?? null);
  });

  it("opens with Shift+F10 or the menu key, navigates enabled actions, and restores focus", async () => {
    const view = await mountMenu();
    view.link?.focus();
    expect((await key(view.link, "F10", true)).defaultPrevented).toBe(true);
    await key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items()[2] ?? null);
    await key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items()[0] ?? null);
    await key(document.activeElement, "ArrowUp");
    expect(document.activeElement).toBe(items()[2] ?? null);
    await key(document.activeElement, "Home");
    expect(document.activeElement).toBe(items()[0] ?? null);
    await key(document.activeElement, "End");
    expect(document.activeElement).toBe(items()[2] ?? null);
    await act(async () => (document.activeElement as HTMLElement).click());
    expect(view.selected).toEqual(["last"]);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(view.link);
    await key(view.link, "ContextMenu");
    expect(menu()).not.toBeNull();
    expect((await key(document.activeElement, "Escape")).defaultPrevented).toBe(
      true,
    );
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(view.link);
  });

  it("dismisses on outside press, focus, scrolling, resize, and window blur", async () => {
    const view = await mountMenu();
    for (const event of [
      "pointerdown",
      "focusin",
      "scroll",
      "resize",
      "blur",
    ]) {
      await contextClick(view.link);
      await act(async () => {
        if (event === "pointerdown")
          view.outside?.dispatchEvent(
            new dom.PointerEvent(event, { bubbles: true }) as never,
          );
        else if (event === "focusin") view.outside?.focus();
        else window.dispatchEvent(new dom.Event(event) as never);
      });
      expect(menu()).toBeNull();
    }
    expect(view.selected).toEqual([]);
  });

  it("dismisses on Tab while allowing normal keyboard navigation", async () => {
    const view = await mountMenu();
    await contextClick(view.link);
    expect((await key(document.activeElement, "Tab")).defaultPrevented).toBe(
      false,
    );
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(view.link);
  });

  it("keeps the native menu on editable fields", async () => {
    const view = await mountMenu();
    expect((await contextClick(view.input)).defaultPrevented).toBe(false);
    expect((await key(view.input, "F10", true)).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("keeps the menu inside the viewport near its bottom-right edge", async () => {
    const view = await mountMenu();
    const original = dom.HTMLElement.prototype.getBoundingClientRect;
    dom.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("contextMenu")
        ? new dom.DOMRect(0, 0, 200, 120)
        : original.call(this);
    };
    try {
      await contextClick(
        view.link,
        window.innerWidth - 1,
        window.innerHeight - 1,
      );
      expect(menu()?.style.left).toBe(`${window.innerWidth - 208}px`);
      expect(menu()?.style.top).toBe(`${window.innerHeight - 128}px`);
    } finally {
      dom.HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("keeps the menu clear of system bars the page draws under", async () => {
    const view = await mountMenu();
    const insets = document.createElement("style");
    insets.textContent = `.contextMenu {
      --safe-area-top: 48px; --safe-area-right: 12px;
      --safe-area-bottom: 24px; --safe-area-left: 30px;
    }`;
    document.head.append(insets);
    const original = dom.HTMLElement.prototype.getBoundingClientRect;
    dom.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("contextMenu")
        ? new dom.DOMRect(0, 0, 200, 120)
        : original.call(this);
    };
    try {
      await contextClick(view.link, 0, 0);
      expect(menu()?.style.left).toBe("38px");
      expect(menu()?.style.top).toBe("56px");
      await key(document.activeElement, "Escape");

      await contextClick(
        view.link,
        window.innerWidth - 1,
        window.innerHeight - 1,
      );
      expect(menu()?.style.left).toBe(`${window.innerWidth - 220}px`);
      expect(menu()?.style.top).toBe(`${window.innerHeight - 152}px`);
    } finally {
      dom.HTMLElement.prototype.getBoundingClientRect = original;
      insets.remove();
    }
  });

  it("opens from a plain click only when asked to", async () => {
    const { control, unmount } = await mountMenu();
    await act(async () => control?.click());
    expect(menu()).toBeNull();

    await unmount();
    container.remove();
    ({ container } = await mount(
      <ContextMenu
        items={[{ id: "only", label: "Only", onSelect: () => {} }]}
        label="Number actions"
        openOnClick
      >
        {(props) => (
          <button {...props} type="button">
            01
          </button>
        )}
      </ContextMenu>,
    ));
    const trigger = container.querySelector("button");
    await act(async () => trigger?.click());
    expect(menu()?.getAttribute("aria-label")).toBe("Number actions");
    expect(document.activeElement).toBe(items()[0] ?? null);
  });

  it("removes an open portal when its target unmounts", async () => {
    const view = await mountMenu();
    await contextClick(view.link);
    await view.unmount();
    expect(menu()).toBeNull();
  });
});
