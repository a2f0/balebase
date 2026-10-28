import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { ContractDetail } from "@balebase/validators/contracts";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Contracts } from "./Contracts";
import { canNavigate } from "./navigationGuard";

const dom = new Window({ url: "http://localhost:5173/contracts/c1" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
const mounted: { container: HTMLElement; root: Root }[] = [];

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(async () => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});
afterEach(async () => {
  for (const { container, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  globalThis.fetch = originalFetch;
});

const draft: ContractDetail = {
  completedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  createdByName: "Owner",
  document: {
    filename: "lease.pdf",
    pageCount: 1,
    sha256: "abc",
    size: 800,
  },
  dueDate: null,
  events: [],
  fields: [],
  finalSha256: null,
  id: "c1",
  message: "",
  recipients: [],
  reminderIntervalDays: null,
  sentAt: null,
  sentByName: null,
  signingOrder: "parallel",
  status: "draft",
  template: null,
  title: "Lease",
  updatedAt: "2026-10-01T12:00:00.000Z",
  voidReason: null,
  voidedAt: null,
};

/** Serves the draft; each draft save answers with the next queued outcome. */
function stubApi(saves: ("fail" | "save")[]) {
  const saved: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === "PUT") {
      const { title } = JSON.parse(String(init.body)) as { title: string };
      if (saves.shift() === "fail")
        return Response.json(
          { error: "Drafts are read-only during maintenance." },
          { status: 503 },
        );
      saved.push(title);
      return Response.json({ contract: { ...draft, title } });
    }
    if (url.endsWith("/document")) return new Response(null, { status: 404 });
    return Response.json({ contract: draft });
  }) as typeof fetch;
  return saved;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () =>
    root.render(
      <>
        <Contracts onNavigate={() => {}} pathname="/contracts/c1" />
        <DialogHost />
      </>,
    ),
  );
  await settle();
  return container;
}

function titleField(container: HTMLElement) {
  const label = [...container.querySelectorAll("label")].find(
    (element) => element.querySelector(".fieldLabel")?.textContent === "Title",
  );
  const input = label?.querySelector("input");
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

/** Types before the autosave delay passes, so only leaving saves the edit. */
async function retitle(container: HTMLElement, title: string) {
  const input = titleField(container);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, title);
    input.dispatchEvent(
      new dom.Event("input", { bubbles: true }) as unknown as Event,
    );
  });
}

/**
 * Asks to leave the page, as every in-app navigation does. The answer is
 * wrapped so awaiting the question does not also wait for a dialog's answer.
 */
async function leave() {
  const question: { allowed?: Promise<boolean> } = {};
  await act(async () => {
    question.allowed = canNavigate();
  });
  await settle();
  return question;
}

async function answer(label: string) {
  const choice = [
    ...(document.querySelector("dialog[open]")?.querySelectorAll("button") ??
      []),
  ].find((element) => element.textContent?.trim() === label);
  expect(choice).toBeTruthy();
  await act(async () => choice?.click());
  await settle();
}

describe("leaving a contract draft", () => {
  it("saves edits the autosave has not reached before leaving", async () => {
    const saved = stubApi(["save"]);
    const container = await mount();
    await retitle(container, "Lease 2027");
    const question = await leave();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(await question.allowed).toBe(true);
    expect(saved).toEqual(["Lease 2027"]);
  });

  it("shows a failed save and keeps the page until the edits are discarded", async () => {
    const saved = stubApi(["fail", "fail", "save"]);
    const container = await mount();
    await retitle(container, "Lease 2027");

    const kept = await leave();
    expect(container.querySelector(".toast")?.textContent).toContain(
      "Drafts are read-only during maintenance.",
    );
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Your latest edits to this draft could not be saved.",
    );
    await answer("Keep editing");
    expect(await kept.allowed).toBe(false);
    expect(titleField(container).value).toBe("Lease 2027");

    const discarded = await leave();
    await answer("Discard changes");
    expect(await discarded.allowed).toBe(true);
    // Discarded edits are not saved behind the person's back on the way out.
    for (const page of mounted.splice(0)) {
      await act(async () => page.root.unmount());
      page.container.remove();
    }
    await settle();
    expect(saved).toEqual([]);
  });
});
