import { expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import { Inbox } from "./Inbox";

const { mount, respond, click, fill, settle, window: dom } = installDom();
it("shows the TXT challenge, verifies the domain, and switches to its connected mailbox", async () => {
  let requested = false;
  let verified = false;
  let connected = false;
  const alias = "inbox+binding@inbox.balebase.com";
  const box = {
    name: "Legal",
    address: "legal@tearleads.com",
    connected: true,
    id: "legal",
    forwardingAddress: alias,
  };
  const claim = {
    id: "d",
    domain: "tearleads.com",
    recordName: "_balebase-verification.tearleads.com",
    recordValue: "balebase-verification=test",
  };
  const lists: string[] = [];
  respond(async (url, init) => {
    if (url.pathname.endsWith("/mx")) return Response.json({ ready: true });
    if (url.pathname.endsWith("/domains")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        domain: "tearleads.com",
      });
      requested = true;
      return Response.json({ ...claim, status: "pending" });
    }
    if (url.pathname.endsWith("/verify")) {
      verified = true;
      return Response.json({ ...claim, status: "verified" });
    }
    if (url.pathname.endsWith("/mailboxes")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "Legal",
        address: "legal@tearleads.com",
      });
      connected = true;
      return Response.json({ id: box.id, forwardingAddress: alias });
    }
    if (url.pathname.endsWith("/routing"))
      return Response.json({
        directMx: { host: "mx.balebase.com", priority: 10 },
        domains: requested
          ? [{ ...claim, status: verified ? "verified" : "pending" }]
          : [],
        mailboxes: connected ? [box] : [],
      });
    lists.push(url.search);
    return Response.json({
      address: url.search ? box.address : "upload+org@inbox.balebase.com",
      emails: [],
      mailboxes: connected ? [box] : [],
    });
  });
  const { container } = await mount(
    <Inbox canManage canAccessFinance={false} onNavigate={() => {}} />,
  );
  await settle();
  const details = container.querySelector("details");
  expect(details).toBeTruthy();
  await act(async () => {
    if (details) {
      details.open = true;
      details.dispatchEvent(new dom.Event("toggle") as never);
    }
  });
  await settle();
  await fill(
    container.querySelector('input[placeholder="example.com"]'),
    "tearleads.com",
  );
  await click("Add domain");
  expect(container.textContent).toContain(claim.recordName);
  expect(container.textContent).toContain(claim.recordValue);
  await click("Verify domain");
  expect(container.textContent).toContain("Verified");
  expect(container.textContent).toContain("mx.balebase.com");
  await click("Check public MX");
  expect(container.textContent).toContain("Public MX records match.");
  await fill(container.querySelector('input[placeholder="Legal"]'), "Legal");
  await fill(container.querySelector('input[type="email"]'), box.address);
  await click("Connect inbox address");
  expect(container.textContent).toContain(alias);
  await fill(container.querySelector("select"), "legal");
  expect(lists.at(-1)).toBe("?mailbox=legal");
  expect(container.querySelector(".inboxAddressValue")?.textContent).toBe(
    box.address,
  );
});

it("refreshes the current mailbox when a routing save settles after a switch", async () => {
  const save = Promise.withResolvers<Response>();
  const selected: string[] = [];
  const box = {
    id: "legal",
    name: "Legal",
    address: "legal@tearleads.com",
    connected: true,
  };
  respond(async (url) => {
    if (url.pathname.endsWith("/domains")) return save.promise;
    if (url.pathname.endsWith("/routing"))
      return Response.json({ domains: [], mailboxes: [] });
    const mailbox = url.searchParams.get("mailbox") ?? "";
    selected.push(mailbox);
    return Response.json({
      mailboxes: [box],
      mailboxId: mailbox || null,
      address: mailbox ? box.address : "upload@example.com",
      emails: [],
    });
  });
  const { container } = await mount(
    <Inbox canManage canAccessFinance={false} onNavigate={() => {}} />,
  );
  const details = container.querySelector("details");
  if (!details) throw new Error("Missing inbox settings");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new dom.Event("toggle") as never);
  });
  await settle();
  await fill(
    container.querySelector('input[placeholder="example.com"]'),
    "tearleads.com",
  );
  await click("Add domain");
  for (const open of [false, true]) {
    await act(async () => {
      details.open = open;
      details.dispatchEvent(new dom.Event("toggle") as never);
    });
  }
  expect(
    container.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.disabled,
  ).toBe(true);
  await fill(container.querySelector("select"), "legal");
  await act(async () => save.resolve(Response.json({ id: "d" })));
  await settle();
  expect(selected.slice(-2)).toEqual(["legal", "legal"]);
  expect(container.querySelector(".inboxAddressValue")?.textContent).toBe(
    box.address,
  );
});
