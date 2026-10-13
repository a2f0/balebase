import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { InboundEmailDetail, InboxFolder } from "./api";
import { Inbox } from "./Inbox";

const dom = new Window({ url: "http://localhost:5173/inbox" });
const domGlobals = {
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
const originalClipboard = Object.getOwnPropertyDescriptor(
  dom.navigator,
  "clipboard",
);
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
  globalThis.fetch = originalFetch;
  if (originalClipboard)
    Object.defineProperty(dom.navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(dom.navigator, "clipboard");
  dom.history.replaceState(null, "", "/inbox");
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<Inbox canAccessFinance={false} onNavigate={() => {}} />),
  );
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent === label ||
      element.getAttribute("aria-label") === label,
  );
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

function stubClipboard(writeText?: (value: string) => Promise<void>) {
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

function fixture(linkCount = 0, listed = true) {
  let status: InboxFolder = "inbox";
  const requests: string[] = [];
  const email: InboundEmailDetail = {
    attachmentCount: 0,
    attachments: [],
    deletedAt: null,
    deletedByEmail: null,
    deletedByName: null,
    deletedByUserId: null,
    from: "sender@example.com",
    html: null,
    id: "email-1",
    linkCount,
    links: [],
    rawSize: 42,
    receivedAt: "2026-10-12T12:00:00.000Z",
    status,
    subject: "Receipt",
    text: "Your purchase receipt",
    to: "upload@example.com",
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/archive")) {
      status = "archived";
      return Response.json({ emailId: email.id });
    }
    if (url.pathname.endsWith("/restore")) {
      status = "inbox";
      return Response.json({ emailId: email.id });
    }
    if (url.pathname.endsWith("/links/link-1") && init?.method === "DELETE") {
      email.linkCount -= 1;
      email.links = [];
      return new Response(null, { status: 204 });
    }
    const folder = url.searchParams.get("folder") ?? "inbox";
    if (url.pathname.endsWith("/email-1")) {
      return folder === status
        ? Response.json({ email: { ...email, status } })
        : Response.json({ error: "Email not found." }, { status: 404 });
    }
    return Response.json({
      address: "upload@example.com",
      emails: listed && folder === status ? [{ ...email, status }] : [],
    });
  }) as typeof fetch;
  return {
    email,
    requests,
    setStatus: (next: InboxFolder) => {
      status = next;
    },
  };
}

describe("Inbox, mounted", () => {
  it("copies the inbound address on click and announces success", async () => {
    fixture();
    const copied: string[] = [];
    stubClipboard(async (value) => {
      copied.push(value);
    });
    await render();
    await click("Copy email address upload@example.com");
    expect(copied).toEqual(["upload@example.com"]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Inbound email address copied.",
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("copies through the shared context menu and restores focus", async () => {
    fixture();
    const copied: string[] = [];
    stubClipboard(async (value) => {
      copied.push(value);
    });
    await render();
    const address = button("Copy email address upload@example.com");
    const event = new dom.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    await act(async () => address.dispatchEvent(event as never));
    expect(event.defaultPrevented).toBe(true);
    expect(copied).toEqual([]);
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(item?.textContent).toBe("Copy email address");
    await act(async () => item?.click());
    expect(copied).toEqual(["upload@example.com"]);
    expect(container.textContent).toContain("Inbound email address copied.");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(address);
  });

  it.each(["rejected", "unavailable"])(
    "reports a %s clipboard and clears the error after retry",
    async (failure) => {
      fixture();
      stubClipboard(
        failure === "rejected"
          ? async () => {
              throw new Error("Permission denied");
            }
          : undefined,
      );
      await render();
      await click("Copy email address upload@example.com");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not copy the email address. Please try again.",
      );
      expect(container.textContent).not.toContain(
        "Inbound email address copied.",
      );
      const copied: string[] = [];
      stubClipboard(async (value) => {
        copied.push(value);
      });
      await click("Copy email address upload@example.com");
      expect(copied).toEqual(["upload@example.com"]);
      expect(container.textContent).not.toContain("Could not copy the email");
      expect(container.textContent).toContain("Inbound email address copied.");
    },
  );

  it("archives a message, reads it from Archived, and moves it back to Inbox", async () => {
    const { requests } = fixture();
    await render();
    expect(button("Move to Trash").disabled).toBe(false);
    expect(
      container
        .querySelector('[aria-label="Email actions"]')
        ?.querySelectorAll("button"),
    ).toHaveLength(2);
    await click("Archive");
    expect(container.textContent).toContain("Email archived.");
    expect(container.textContent).toContain("No messages yet");
    await click("Archived");
    expect(container.textContent).toContain("Your purchase receipt");
    await click("Move to Inbox");
    expect(container.textContent).toContain("No archived messages");
    await click("Inbox");
    expect(container.textContent).toContain("Your purchase receipt");
    expect(requests).toContain("POST /api/inbox/email-1/archive");
    expect(requests).toContain("POST /api/inbox/email-1/restore");
  });

  it("disables Trash for hidden links while allowing Archive", async () => {
    fixture(1);
    await render();
    expect(button("Move to Trash").disabled).toBe(true);
    expect(button("Archive").disabled).toBe(false);
    expect(container.textContent).toContain(
      "Linked emails cannot be moved to Trash",
    );
    await click("Archive");
    await click("Archived");
    expect(button("Move to Trash").disabled).toBe(true);
  });

  it("enables Trash after removing the last link", async () => {
    const { email } = fixture(1);
    email.links = [
      {
        id: "link-1",
        targetId: "folder-1",
        targetType: "library_folder",
        folder: { name: "Receipts" },
      },
    ];
    await render();
    expect(button("Move to Trash").disabled).toBe(true);
    await click("Unlink Receipts");
    expect(button("Move to Trash").disabled).toBe(false);
  });

  it("opens a linked archived email even when the listing is empty", async () => {
    const { setStatus } = fixture(1, false);
    setStatus("archived");
    dom.history.replaceState(null, "", "/inbox?email=email-1&folder=archived");
    await render();
    expect(button("Archived").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Your purchase receipt");
    expect(dom.location.search).toBe("");
  });
});
