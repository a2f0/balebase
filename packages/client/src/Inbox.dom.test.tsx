import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { InboundEmailDetail, InboxFolder } from "./api";
import { Inbox } from "./Inbox";

const dom = new Window({ url: "http://localhost:5173/inbox" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
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
