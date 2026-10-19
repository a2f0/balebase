import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { EmployeeForms } from "./EmployeeForms";
import type { EmployeeRequirement } from "./employeeFormsApi";

const dom = new Window({ url: "http://localhost:5173/organization/people" });
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
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

function screening(
  overrides: Partial<EmployeeRequirement>,
): EmployeeRequirement {
  return {
    canSubmitCheckr: false,
    checkrAvailable: true,
    checkrReportStatus: "complete",
    checkrRequested: false,
    checkrResult: null,
    checkrSubmitting: false,
    checkrWorkLocation: { city: "San Jose", state: "CA" },
    completedAt: null,
    documentFilename: null,
    documentRevision: 0,
    documentSize: null,
    dueDate: "2026-10-31",
    hasCheckrConsent: true,
    hasDocument: false,
    id: "screening",
    invitationId: null,
    invitationStatus: null,
    kind: "background_check",
    memberId: "member",
    status: "in_progress",
    targetEmail: "person@example.com",
    targetName: "Pat Person",
    title: "Background check",
    ...overrides,
  };
}

async function render(
  requirements: EmployeeRequirement[],
  canManage = true,
  onNavigate?: (pathname: string) => void,
) {
  globalThis.fetch = (async () =>
    Response.json({ requirements })) as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <EmployeeForms
        canManage={canManage}
        onNavigate={onNavigate}
        scope={{ kind: "member", memberId: "member" }}
      />,
    ),
  );
}

function button(within: Element, label: string) {
  const match = [...within.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button labeled ${label}`);
  return match;
}

function item(title: string) {
  const match = [...container.querySelectorAll(".requirementItem")].find(
    (element) => element.querySelector("strong")?.textContent === title,
  );
  if (!match) throw new Error(`No requirement titled ${title}`);
  return match;
}

describe("requesting forms on a member's page", () => {
  it("lists only that member's requests and sends new ones to them", async () => {
    const posted: unknown[] = [];
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ ids: ["new"] });
      }
      return Response.json({
        requirements: [
          screening({ id: "own", title: "Own check" }),
          screening({
            id: "other",
            memberId: "someone-else",
            title: "Their check",
          }),
        ],
      });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <EmployeeForms
          canManage
          scope={{ kind: "member", memberId: "member" }}
        />,
      ),
    );
    expect(item("Own check")).toBeTruthy();
    expect(container.textContent).not.toContain("Their check");

    const date = container.querySelector<HTMLInputElement>(
      ".requirementEditor input[type=date]",
    );
    const setValue = Object.getOwnPropertyDescriptor(
      dom.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue?.call(date, "2026-11-15");
      date?.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
    });
    const press = async (label: string) => {
      const target = [...container.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === label,
      );
      await act(async () => target?.click());
    };
    await press("Add");
    await press("Send requests");

    expect(posted).toEqual([
      {
        memberId: "member",
        requirements: [
          expect.objectContaining({
            dueDate: "2026-11-15",
            kind: "form",
            title: "W-4",
          }),
        ],
      },
    ]);
  });
});

describe("Checkr screening results", () => {
  it("shows the result, completion date, and review guidance", async () => {
    await render([
      screening({
        checkrResult: "clear",
        completedAt: "2026-10-07T11:09:40.000Z",
        id: "clear",
        status: "complete",
        title: "Clear check",
      }),
      screening({
        checkrResult: "consider",
        completedAt: "2026-10-07T11:09:40.000Z",
        id: "consider",
        status: "complete",
        title: "Consider check",
      }),
      screening({
        checkrReportStatus: "pending",
        id: "pending",
        title: "Pending check",
      }),
    ]);

    const clear = item("Clear check");
    const clearBadge = clear.querySelector(".checkrResult .badge");
    expect(clearBadge?.textContent).toBe("Checkr result: Clear");
    expect(clearBadge?.className).toContain("badgeSuccess");
    const completedOn = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(new Date("2026-10-07T11:09:40.000Z"));
    expect(clear.textContent).toContain(`Completed ${completedOn}`);
    expect(clear.textContent).not.toContain("Review it in Checkr");
    expect(clear.textContent).not.toContain("Checkr: complete");
    expect(clear.textContent).toContain("Refresh check");
    expect(clear.textContent).toContain("Signed authorization");

    const consider = item("Consider check");
    const considerBadge = consider.querySelector(".checkrResult .badge");
    expect(considerBadge?.textContent).toBe("Checkr result: Consider");
    expect(considerBadge?.className).toContain("badgeWarning");
    expect(consider.textContent).toContain(
      "The report found records to review. Review it in Checkr before making a decision.",
    );

    const pending = item("Pending check");
    expect(pending.querySelector(".checkrResult")).toBeNull();
    expect(pending.textContent).toContain("Checkr: pending");
  });

  it("keeps the report status beside a result from a canceled report", async () => {
    await render([
      screening({
        checkrReportStatus: "partially_canceled",
        checkrResult: "consider",
        status: "pending",
        title: "Partial check",
      }),
    ]);

    const partial = item("Partial check");
    expect(partial.textContent).toContain("Checkr result: Consider");
    expect(partial.textContent).toContain("Checkr: partially canceled");
    expect(partial.textContent).toContain("Request again");
  });

  it("hides the result from the screened person", async () => {
    await render(
      [
        screening({
          checkrResult: "clear",
          completedAt: "2026-10-07T11:09:40.000Z",
          status: "complete",
          title: "Own check",
        }),
      ],
      false,
    );

    const own = item("Own check");
    expect(own.querySelector(".checkrResult")).toBeNull();
    expect(own.textContent).toContain("Complete");
    expect(own.textContent).toContain("Submitted to Checkr");
    expect(own.textContent).toContain("Signed authorization");
  });
});

describe("requesting a Checkr background check", () => {
  it("requests a check at a work location and says whether the person was emailed", async () => {
    const posted: Array<{ body: unknown; url: string }> = [];
    let requested = false;
    globalThis.fetch = (async (input, init) => {
      if (init?.method === "POST") {
        posted.push({
          body: JSON.parse(String(init.body)),
          url: String(input),
        });
        requested = true;
        return Response.json({ emailed: false });
      }
      return Response.json({
        requirements: [
          screening({
            checkrReportStatus: null,
            checkrRequested: requested,
            checkrWorkLocation: requested
              ? { city: "Austin", state: "TX" }
              : null,
            hasCheckrConsent: false,
            status: "pending",
          }),
        ],
      });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <EmployeeForms
          canManage
          scope={{ kind: "member", memberId: "member" }}
        />,
      ),
    );
    const check = item("Background check");
    const setValue = Object.getOwnPropertyDescriptor(
      dom.HTMLInputElement.prototype,
      "value",
    )?.set;
    for (const [label, value] of [
      ["Work state for Background check", "tx"],
      ["Work city for Background check", "Austin"],
    ] as const) {
      const input = check.querySelector<HTMLInputElement>(
        `[aria-label="${label}"]`,
      );
      await act(async () => {
        setValue?.call(input, value);
        input?.dispatchEvent(
          new dom.Event("input", { bubbles: true }) as never,
        );
      });
    }
    await act(async () => button(check, "Request background check").click());
    expect(posted).toEqual([
      {
        body: { city: "Austin", state: "TX" },
        url: "http://localhost:8787/api/employee-forms/screening/checkr/request",
      },
    ]);
    expect(container.textContent).toContain(
      "Background check requested, but the email to Pat Person couldn’t be sent.",
    );
    const waiting = item("Background check");
    expect(waiting.textContent).toContain("Waiting for Pat Person’s details");
    expect(button(waiting, "Update request")).toBeTruthy();
    expect(
      waiting.querySelector<HTMLInputElement>(
        '[aria-label="Work state for Background check"]',
      )?.value,
    ).toBe("TX");
  });

  it("links the person to their screening form", async () => {
    const paths: string[] = [];
    await render(
      [
        screening({
          canSubmitCheckr: true,
          checkrReportStatus: null,
          checkrRequested: true,
          hasCheckrConsent: false,
          status: "pending",
        }),
      ],
      false,
      (pathname) => paths.push(pathname),
    );
    const link =
      item("Background check").querySelector<HTMLAnchorElement>("a.button");
    expect(link?.textContent).toBe("Complete background check");
    expect(link?.getAttribute("href")).toBe(
      "/organization/people/member/screening/screening",
    );
    await act(async () =>
      link?.dispatchEvent(
        new dom.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }) as never,
      ),
    );
    expect(paths).toEqual(["/organization/people/member/screening/screening"]);
  });
});
