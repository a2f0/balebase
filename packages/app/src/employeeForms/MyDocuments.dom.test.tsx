import { describe, expect, it } from "bun:test";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import { act } from "react";
import { installDom } from "../testing/dom";
import { MyDocuments } from "./MyDocuments";

const {
  mount,
  respond,
  window: dom,
} = installDom({ url: "http://localhost:5173/me" });
let container: HTMLElement;

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
  respond(async ({ href: url }, init) => {
    calls.push({ method: init?.method ?? "GET", url });
    if (init?.method === "POST") {
      return Response.json({ filename: "w4.pdf", status: "submitted" });
    }
    return Response.json({ requirements });
  });
  return calls;
}

async function render(
  pathname = "/me",
  onNavigate: (pathname: string) => void = () => {},
) {
  ({ container } = await mount(
    <MyDocuments
      onNavigate={onNavigate}
      organization={{ id: "org", name: "Acme" }}
      pathname={pathname}
    />,
  ));
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
    expect(
      [...section("Done").querySelectorAll("a")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual(["/me/requests/done", "/me/screening/done"]);
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
    respond(async () =>
      Response.json(
        { error: "This background check isn’t waiting for you." },
        { status: 409 },
      ),
    );
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

  it("opens each request's own page from its title", async () => {
    stubApi(requests);
    const paths: string[] = [];
    await render("/me", (path) => paths.push(path));

    const title = section("To do").querySelector<HTMLAnchorElement>("strong a");
    expect(title?.textContent).toBe("W-4");
    expect(title?.getAttribute("href")).toBe("/me/requests/w4");
    await act(async () =>
      title?.dispatchEvent(
        new dom.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }) as never,
      ),
    );
    expect(paths).toEqual(["/me/requests/w4"]);
  });

  it("explains a background check the organization runs without Checkr", async () => {
    stubApi([
      requirement({
        id: "manual",
        kind: "background_check",
        title: "Background check",
      }),
    ]);
    await render();
    expect(rows("With Acme")).toEqual([
      { badge: "Not started", title: "Background check" },
    ]);
    expect(section("With Acme").textContent).toContain(
      "Acme runs this check and contacts you if it needs anything.",
    );

    await render("/me/requests/manual");
    expect(container.querySelector("h1")?.textContent).toBe("Background check");
    expect(container.textContent).toContain("Requested byAcme");
    expect(container.textContent).toContain(
      "There’s nothing for you to do here.",
    );
    expect(container.textContent).not.toContain("Start background check");
  });

  it("says a Checkr background check is coming before it's requested", async () => {
    stubApi([
      requirement({
        checkrAvailable: true,
        id: "later",
        kind: "background_check",
        title: "Background check",
      }),
    ]);
    await render("/me/requests/later");
    expect(container.textContent).toContain(
      "Acme hasn’t sent you this check yet. When it does, you’ll get an email and can start it from My documents.",
    );
  });

  it("starts the background check from its request page", async () => {
    stubApi(requests);
    await render("/me/requests/check");
    expect(container.textContent).toContain("Work locationAustin, TX");
    const start = [...container.querySelectorAll("a")].find(
      (element) => element.textContent === "Start background check",
    );
    expect(start?.getAttribute("href")).toBe("/me/screening/check");
  });

  it("uploads a form from its request page", async () => {
    const calls = stubApi([requirement({ id: "w4", title: "W-4" })]);
    await render("/me/requests/w4");
    expect(container.textContent).toContain("Upload a PDF, JPEG, or PNG.");
    const input = container.querySelector<HTMLInputElement>("input[type=file]");
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

  it("does not show a request that isn't the person's", async () => {
    stubApi(requests);
    await render("/me/requests/another-person");
    expect(container.textContent).toContain(
      "This request isn’t in your documents.",
    );
  });
});
