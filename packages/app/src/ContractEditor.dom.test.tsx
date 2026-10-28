import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { ContractDetail } from "@balebase/validators/contracts";
import { act } from "react";
import { autosaveDelayMs } from "./ContractEditor";
import { Contracts } from "./Contracts";
import { canNavigate } from "./navigationGuard";
import { holdTimers, installDom } from "./testing/dom";

const { button, click, fill, mount, respond, settle } = installDom({
  url: "http://localhost:5173/contracts/c1",
});

// Holds the autosave so only leaving saves an edit, however slow the run.
let autosave: ReturnType<typeof holdTimers>;
beforeEach(() => {
  autosave = holdTimers(autosaveDelayMs);
});
afterEach(() => autosave.restore());

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
  respond(async (url, init) => {
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
    if (url.pathname.endsWith("/document"))
      return new Response(null, { status: 404 });
    return Response.json({ contract: draft });
  });
  return saved;
}

async function mountEditor() {
  const view = await mount(
    <>
      <Contracts onNavigate={() => {}} pathname="/contracts/c1" />
      <DialogHost />
    </>,
  );
  await settle();
  return view;
}

function titleField(container: HTMLElement) {
  const label = [...container.querySelectorAll("label")].find(
    (element) => element.querySelector(".fieldLabel")?.textContent === "Title",
  );
  const input = label?.querySelector("input");
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

/** Types an edit the held autosave never saves, so only leaving does. */
async function retitle(container: HTMLElement, title: string) {
  await fill(titleField(container), title);
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
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) throw new Error("No open dialog");
  await click(button(label, dialog));
}

describe("leaving a contract draft", () => {
  it("saves edits the autosave has not reached before leaving", async () => {
    const saved = stubApi(["save"]);
    const { container } = await mountEditor();
    await retitle(container, "Lease 2027");
    const question = await leave();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(await question.allowed).toBe(true);
    expect(saved).toEqual(["Lease 2027"]);
  });

  it("also saves edits made while the leaving save is in flight", async () => {
    const saved: string[] = [];
    let release = () => {};
    respond(async (url, init) => {
      if (init?.method === "PUT") {
        const { title } = JSON.parse(String(init.body)) as { title: string };
        if (saved.length === 0)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        saved.push(title);
        return Response.json({ contract: { ...draft, title } });
      }
      if (url.pathname.endsWith("/document"))
        return new Response(null, { status: 404 });
      return Response.json({ contract: draft });
    });
    const { container } = await mountEditor();
    await retitle(container, "Lease 2027");
    const question = await leave();
    await retitle(container, "Lease 2028");
    await act(async () => release());
    await settle();
    expect(await question.allowed).toBe(true);
    expect(saved).toEqual(["Lease 2027", "Lease 2028"]);
  });

  it("shows a failed save and keeps the page until the edits are discarded", async () => {
    const saved = stubApi(["fail", "fail", "save"]);
    const { container, unmount } = await mountEditor();
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
    await unmount();
    await settle();
    expect(saved).toEqual([]);
  });
});
