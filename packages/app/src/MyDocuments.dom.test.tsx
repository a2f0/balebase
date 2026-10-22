import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MyDocuments } from "./MyDocuments";

const dom = new Window({ url: "http://localhost:5173/me" });
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
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

function requirement(
  overrides: Partial<EmployeeRequirement>,
): EmployeeRequirement {
  return {
    canSubmitCheckr: false,
    checkrAvailable: false,
    checkrReportStatus: null,
    checkrRequested: false,
    checkrResult: null,
    checkrSubmitting: false,
    checkrWorkLocation: null,
    completedAt: null,
    documentFilename: null,
    documentRevision: 0,
    documentSize: null,
    dueDate: "2999-12-31",
    hasCheckrConsent: false,
    hasDocument: false,
    id: "requirement",
    invitationId: null,
    invitationStatus: null,
    kind: "form",
    memberId: "member",
    status: "pending",
    targetEmail: "pat@example.com",
    targetName: "Pat Person",
    title: "W-4",
    ...overrides,
  };
}

const requests = [
  requirement({ dueDate: "2000-01-01", id: "w4", title: "W-4" }),
  requirement({
    canSubmitCheckr: true,
    checkrAvailable: true,
    checkrRequested: true,
    checkrWorkLocation: { city: "Austin", state: "TX" },
    id: "check",
    kind: "background_check",
    title: "Background check",
  }),
  requirement({
    documentFilename: "w9.pdf",
    hasDocument: true,
    id: "w9",
    status: "submitted",
    title: "W-9",
  }),
  requirement({
    checkrReportStatus: "pending",
    hasCheckrConsent: true,
    id: "running",
    kind: "background_check",
    status: "in_progress",
    title: "Driving record",
  }),
  requirement({ id: "credit", kind: "credit_check", title: "Credit check" }),
  requirement({
    completedAt: "2026-10-07T11:09:40.000Z",
    documentFilename: "i9.pdf",
    hasDocument: true,
    id: "i9",
    status: "complete",
    title: "I-9",
  }),
];

/** Serves the person's own requests and records every request. */
function stubApi(requirements: EmployeeRequirement[]) {
  const calls: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (init?.method === "POST") {
      return Response.json({ filename: "w4.pdf", status: "submitted" });
    }
    return Response.json({ requirements });
  }) as typeof fetch;
  return calls;
}

async function render(
  pathname = "/me",
  onNavigate: (pathname: string) => void = () => {},
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MyDocuments
        onNavigate={onNavigate}
        organization={{ id: "org", name: "Acme" }}
        pathname={pathname}
      />,
    ),
  );
}

function section(title: string) {
  const match = [...container.querySelectorAll("section")].find(
    (element) => element.querySelector("h2")?.textContent === title,
  );
  if (!match) throw new Error(`No section titled ${title}`);
  return match;
}

function rows(title: string) {
  return [...section(title).querySelectorAll(".myDocument")].map((row) => ({
    badge: row.querySelector(".badge")?.textContent,
    title: row.querySelector("strong")?.textContent,
  }));
}

function stats() {
  return Object.fromEntries(
    [...container.querySelectorAll(".myDocumentsStat")].map((stat) => [
      stat.querySelector("dt")?.textContent,
      stat.querySelector("dd")?.textContent,
    ]),
  );
}

describe("My documents", () => {
  it("sorts the person's own requests by who acts next", async () => {
    const calls = stubApi(requests);
    await render();

    expect(calls).toEqual([
      {
        method: "GET",
        url: "http://localhost:8787/api/employee-forms?for=me",
      },
    ]);
    expect(stats()).toEqual({
      Done: "1",
      Overdue: "1",
      "To do": "2",
      "With Acme": "3",
    });
    expect(rows("To do")).toEqual([
      { badge: "Overdue", title: "W-4" },
      { badge: "To do", title: "Background check" },
    ]);
    expect(rows("With Acme")).toEqual([
      { badge: "In review", title: "W-9" },
      { badge: "Report in progress", title: "Driving record" },
      { badge: "Not started", title: "Credit check" },
    ]);
    expect(rows("Done")).toEqual([{ badge: "Complete", title: "I-9" }]);
    expect(section("With Acme").textContent).toContain(
      "Acme is reviewing w9.pdf.",
    );
    expect(section("With Acme").textContent).toContain("Signed authorization");
    expect(section("Done").textContent).not.toContain("Upload file");
  });

  it("opens the background check form from To do", async () => {
    stubApi(requests);
    const paths: string[] = [];
    await render("/me", (path) => paths.push(path));

    const link = [...section("To do").querySelectorAll("a")].find(
      (element) => element.textContent === "Start background check",
    );
    expect(link?.getAttribute("href")).toBe("/me/screening/check");
    expect(section("To do").textContent).toContain("for work in Austin, TX");
    await act(async () =>
      link?.dispatchEvent(
        new dom.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }) as never,
      ),
    );
    expect(paths).toEqual(["/me/screening/check"]);
  });

  it("uploads a requested form", async () => {
    const calls = stubApi([requirement({ id: "w4", title: "W-4" })]);
    await render();

    const input =
      section("To do").querySelector<HTMLInputElement>("input[type=file]");
    expect(input?.getAttribute("aria-label")).toBe("Upload file");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: { 0: new File(["PDF"], "w4.pdf"), length: 1 },
    });
    await act(async () => {
      input?.dispatchEvent(new dom.Event("change", { bubbles: true }) as never);
    });
    expect(calls).toContainEqual({
      method: "POST",
      url: "http://localhost:8787/api/employee-forms/w4/document",
    });
    expect(container.textContent).toContain("W-4 sent.");
  });

  it("opens a completed screening from its email and refreshes its status without exposing results", async () => {
    const screening = requirement({
      id: "check",
      kind: "background_check",
      title: "Background check",
      checkrReportStatus: "complete",
      status: "complete",
      completedAt: "2026-10-20T12:00:00Z",
      hasCheckrConsent: true,
      checkrResult: "consider",
    });
    const calls = stubApi([screening]);
    await render("/me/screening/check");
    expect(container.textContent).toContain("Report ready");
    expect(container.textContent).toContain(
      "A completed report is not a hiring decision.",
    );
    expect(container.textContent).not.toContain("consider");
    expect(container.textContent).toContain(
      "Download your signed authorization",
    );
    expect(
      calls.every((call) => call.url.endsWith("/api/employee-forms?for=me")),
    ).toBe(true);
    screening.checkrReportStatus = "dispute";
    screening.status = "in_progress";
    screening.completedAt = null;
    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh status",
    );
    await act(async () => refresh?.click());
    expect(container.textContent).toContain("Checkr is reviewing a dispute");
    expect(container.textContent).not.toContain("Report ready");
  });

  it("keeps completed screening links and explains suspended reports", async () => {
    stubApi([
      requirement({
        id: "done",
        kind: "background_check",
        checkrReportStatus: "complete",
        status: "complete",
      }),
      requirement({
        id: "paused",
        kind: "background_check",
        checkrReportStatus: "suspended",
        status: "in_progress",
      }),
    ]);
    await render();
    expect(section("Done").querySelector("a")?.getAttribute("href")).toBe(
      "/me/screening/done",
    );
    expect(section("With Acme").textContent).toContain(
      "Check your email for a request from Checkr",
    );
  });

  it("does not show another person's screening from a guessed email link", async () => {
    stubApi([]);
    await render("/me/screening/another-person");
    expect(container.textContent).toContain("Background check not found.");
    expect(container.textContent).not.toContain(
      "Download your signed authorization",
    );
  });

  it("shows a canceled check that the organization completed by hand as complete", async () => {
    stubApi([
      requirement({
        id: "check",
        kind: "background_check",
        checkrReportStatus: "canceled",
        status: "complete",
      }),
    ]);
    await render("/me/screening/check");
    expect(container.textContent).toContain("Acme marked this check complete.");
    expect(container.textContent).not.toContain(
      "Contact Acme about next steps",
    );
    expect(container.querySelector(".badge")?.textContent).toBe("Complete");
  });

  it("says when nothing has been requested", async () => {
    stubApi([]);
    await render();
    expect(container.textContent).toContain("Nothing requested yet");
    expect(container.querySelector(".myDocumentsStat")).toBeNull();
  });

  it("shows the background check form under My documents", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "This background check isn’t waiting for you." },
        { status: 409 },
      )) as unknown as typeof fetch;
    await render("/me/screening/check");

    expect(container.querySelector("h1")?.textContent).toBe(
      "Your background check",
    );
    const backLinks = [...container.querySelectorAll("a")].filter(
      (element) => element.getAttribute("href") === "/me",
    );
    expect(backLinks.map((element) => element.textContent)).toEqual([
      "My documents",
      "Back to My documents",
    ]);
    expect(container.textContent).toContain(
      "This background check isn’t waiting for you.",
    );
  });
});
