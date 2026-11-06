import { afterEach, describe, expect, it } from "bun:test";
import type {
  InboundEmailDetail,
  InboxFolder,
} from "@balebase/validators/inbox";
import { act } from "react";
import { installDom } from "../testing/dom";
import { Inbox } from "./Inbox";

const {
  button,
  click,
  mount,
  respond,
  settle,
  stubClipboard,
  window: dom,
} = installDom({ url: "http://localhost:5173/inbox" });
let container: HTMLElement;

afterEach(() => {
  dom.history.replaceState(null, "", "/inbox");
});

async function render() {
  ({ container } = await mount(
    <Inbox canAccessFinance={false} onNavigate={() => {}} />,
  ));
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
  respond(async (url, init) => {
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
    if (url.pathname.endsWith("/activity")) {
      return Response.json({ events: [], nextCursor: null });
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
  });
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
    expect(container.querySelector(".toast")?.textContent).toContain(
      "Inbound email address copied.",
    );
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
    expect(requests).toContain("GET /api/inbox/email-1/activity");
    expect(requests).toContain("POST /api/inbox/email-1/archive");
    expect(requests).toContain("POST /api/inbox/email-1/restore");
  });

  it("keeps a message chosen while another is being archived", async () => {
    const archived = new Set<string>();
    const archiving = Promise.withResolvers<void>();
    const message = (id: string, subject: string, receivedAt: string) => ({
      attachmentCount: 0,
      attachments: [],
      deletedAt: null,
      deletedByEmail: null,
      deletedByName: null,
      deletedByUserId: null,
      from: "sender@example.com",
      html: null,
      id,
      linkCount: 0,
      links: [],
      rawSize: 42,
      receivedAt,
      status: "inbox" as const,
      subject,
      text: `${subject} body`,
      to: "upload@example.com",
    });
    const emails = [
      message("email-1", "Receipt", "2026-10-12T12:00:00.000Z"),
      message("email-2", "Invoice", "2026-10-11T12:00:00.000Z"),
      message("email-3", "Statement", "2026-10-10T12:00:00.000Z"),
    ];
    respond(async (url) => {
      if (url.pathname.endsWith("/archive")) {
        await archiving.promise;
        archived.add("email-1");
        return Response.json({ emailId: "email-1" });
      }
      if (url.pathname.endsWith("/activity"))
        return Response.json({ events: [], nextCursor: null });
      const opened = emails.find(({ id }) => url.pathname.endsWith(`/${id}`));
      if (opened) return Response.json({ email: opened });
      return Response.json({
        address: "upload@example.com",
        emails: emails.filter(({ id }) => !archived.has(id)),
      });
    });
    await render();
    await click("Archive");
    // Chosen while the archive of the first message is still on its way.
    const statement = [
      ...container.querySelectorAll<HTMLButtonElement>(".inboxItem"),
    ].find((item) => item.textContent?.includes("Statement"));
    await act(async () => statement?.click());
    await act(async () => archiving.resolve());
    await settle();
    expect(container.textContent).toContain("Email archived.");
    const selected = container.querySelector('.inboxItem[aria-pressed="true"]');
    expect(selected?.textContent).toContain("Statement");
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
