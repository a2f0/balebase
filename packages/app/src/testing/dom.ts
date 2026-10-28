import { afterAll, afterEach, beforeAll, expect, spyOn } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { installFetch } from "./fetch";

interface Mounted {
  container: HTMLElement;
  /** Renders synchronously, for a caller already inside `act`. */
  root: Root;
  render: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

interface DomOptions {
  /** Window members to install beyond the document basics. */
  globals?: (window: Window) => Record<string, unknown>;
  /** The page's address, and so its location and first history entry. */
  url?: string;
}

/**
 * Runs a test file in a happy-dom window. Call once at the file's top level:
 * it registers hooks that install the window as globals, unmount what each
 * test mounted and restore `fetch` after it, and restore the globals and
 * close the window after the file.
 */
export function installDom({ globals, url }: DomOptions = {}) {
  const window = new Window(url === undefined ? {} : { url });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const mounted: Mounted[] = [];
  let clipboardStubbed = false;
  let createRoot: (container: Element) => Root;

  beforeAll(async () => {
    const installed = {
      document: window.document,
      Element: window.Element,
      HTMLElement: window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      navigator: window.navigator,
      Node: window.Node,
      window,
      ...globals?.(window),
    };
    for (const [key, value] of Object.entries(installed)) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value,
        writable: true,
      });
    }
    // React DOM decides whether it can use the DOM when first loaded.
    ({ createRoot } = await import("react-dom/client"));
  });

  // Registered before fetch's restore, so a request sent while unmounting
  // still reaches the test's stub.
  afterEach(async () => {
    for (const { container, unmount } of mounted.splice(0)) {
      await unmount();
      container.remove();
    }
    if (clipboardStubbed) Reflect.deleteProperty(window.navigator, "clipboard");
    clipboardStubbed = false;
  });
  const respond = installFetch();

  afterAll(async () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  });

  /** Renders into a new container in the document until the test ends. */
  async function mount(node: ReactNode) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const view: Mounted = {
      container,
      root,
      render: (next) => act(async () => root.render(next)),
      unmount: () => act(async () => root.unmount()),
    };
    mounted.push(view);
    await view.render(node);
    return view;
  }

  /** Replaces the clipboard until the test ends, or removes it. */
  function stubClipboard(writeText?: (text: string) => Promise<void>) {
    clipboardStubbed = true;
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: writeText ? { writeText } : undefined,
    });
  }

  /** Renders into this test's latest mount, or mounts it. */
  async function render(node: ReactNode) {
    const view = mounted.at(-1);
    if (!view) return mount(node);
    await view.render(node);
    return view;
  }

  return {
    button,
    click,
    clickLink,
    fill,
    mount,
    queryButton,
    render,
    respond,
    settle,
    stubClipboard,
    window,
  };
}

/**
 * Holds every timer set for exactly `delay` milliseconds until `fire` runs
 * them, as though that much time had passed; other timers run as usual.
 * Dispose of it, or call `restore`, to put the real timers back.
 */
export function holdTimers(delay: number) {
  const { clearTimeout: realClear, setTimeout: realSet } = globalThis;
  const held = new Map<number, () => void>();
  let lastId = 0;
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout !== delay || typeof handler !== "function")
      return realSet(handler, timeout, ...args);
    // Negative IDs never collide with a real timer's.
    lastId -= 1;
    held.set(lastId, () => handler(...args));
    return lastId;
  }) as unknown as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((
    id?: number | Timer,
  ) => {
    if (typeof id === "number" && held.delete(id)) return;
    realClear(id);
  }) as typeof clearTimeout);
  const restore = () => {
    set.mockRestore();
    clear.mockRestore();
  };
  return {
    /** Runs the timers held so far, then settles. */
    async fire() {
      const due = [...held.values()];
      held.clear();
      await act(async () => {
        for (const run of due) run();
      });
      await settle();
    },
    restore,
    [Symbol.dispose]: restore,
  };
}

/** Lets pending effects, timers, and responses run. */
async function settle(milliseconds = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

/** The first button in `scope` with this text or accessible label. */
function button(label: string, scope: ParentNode = document) {
  const match = queryButton(label, scope);
  if (!match) throw new Error(`No button labeled ${label}`);
  return match;
}

/**
 * Like `button`, but null when there is none, or no scope: null rather than
 * undefined, so it compares with `document.activeElement`.
 */
function queryButton(label: string, scope: ParentNode | null | undefined) {
  return (
    [...(scope?.querySelectorAll("button") ?? [])].find(
      (element) =>
        element.textContent?.trim() === label ||
        element.getAttribute("aria-label") === label,
    ) ?? null
  );
}

/** Clicks an element, or the button with this label, then settles. */
async function click(target: Element | string | null | undefined) {
  const element = typeof target === "string" ? button(target) : target;
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
}

/** Clicks a link as a mouse does and reports whether the app took it over. */
function clickLink(link: Element, init: MouseEventInit = {}) {
  const event = new window.MouseEvent("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
    ...init,
  });
  link.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Sets a field's value through its native setter, as typing does. */
async function fill(
  field:
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | null
    | undefined,
  value: string,
) {
  expect(field).toBeTruthy();
  const select = field?.tagName === "SELECT";
  const prototype = select
    ? window.HTMLSelectElement.prototype
    : field?.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value,
    );
    // React hears a select change through `change` and typing through `input`.
    field?.dispatchEvent(
      new window.Event(select ? "change" : "input", { bubbles: true }),
    );
  });
}
