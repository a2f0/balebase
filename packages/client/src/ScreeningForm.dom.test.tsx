import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ScreeningForm as ScreeningFormData } from "./employeeFormsApi";
import { ScreeningForm } from "./ScreeningForm";

const dom = new Window({
  url: "http://localhost:5173/organization/people/member/screening/check",
});
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

const section = (title: string) => ({ paragraphs: [`${title} text.`], title });

const form: ScreeningFormData = {
  candidate: { email: "homer@example.com", name: "Homer" },
  disclosureFingerprint: "shown-wording",
  disclosures: {
    authorization: section("Authorization"),
    disclosure: section("Disclosure Regarding Background Investigation"),
    electronicRecords: section("Electronic records and signature"),
    stateNotices: {
      CA: { ...section("California notice"), offersCopy: true },
      NY: { ...section("New York notice"), offersCopy: false },
    },
    summaryOfRights: section("A Summary of Your Rights"),
    version: "2026-10-19",
  },
  organizationName: "Acme",
  requestRevision: "2026-10-19T12:00:00.000Z",
  requiresDriverLicense: true,
  summaryOfRightsUrl: "https://example.com/rights.pdf",
  testCandidates: [
    {
      dob: "1983-02-10",
      driverLicenseNumber: "M2233344",
      driverLicenseState: "CA",
      expectedResult: "clear",
      findings: [],
      firstName: "Homer",
      id: "homer-simpson",
      lastName: "Simpson",
      location: "San Jose, CA",
      middleName: null,
      ssn: "110-11-1100",
      state: "CA",
      zipcode: "94088",
    },
    {
      dob: "1983-02-10",
      driverLicenseNumber: "N00000328",
      driverLicenseState: "NE",
      expectedResult: "consider",
      findings: ["County criminal: Kidnapping"],
      firstName: "Bruce",
      id: "bruce-ralph-clark",
      lastName: "Clark",
      location: "Omaha, NE",
      middleName: "Ralph",
      ssn: "001-01-0011",
      state: "NE",
      zipcode: "68101",
    },
  ],
  title: "Background check",
  workLocation: { city: "San Jose", state: "CA" },
};

async function mount(data: ScreeningFormData, submitted: unknown[]) {
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") {
      submitted.push(JSON.parse(String(init.body)));
      expect(String(input)).toEndWith(
        "/api/employee-forms/check/checkr/submit",
      );
      return Response.json({ status: "pending" });
    }
    return Response.json(data);
  }) as typeof fetch;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <ScreeningForm
        memberId="member"
        onNavigate={() => undefined}
        requirementId="check"
      />,
    ),
  );
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button labeled ${label}`);
  return match;
}

async function check(label: string) {
  const match = [...container.querySelectorAll("label.check")].find((element) =>
    element.textContent?.includes(label),
  );
  const box = match?.querySelector("input");
  if (!box) throw new Error(`No checkbox for ${label}`);
  await act(async () => box.click());
}

async function proceed(label = "Continue") {
  await act(async () => button(label).click());
}

function heading() {
  return container.querySelector(".cardTitle")?.textContent;
}

describe("screening form", () => {
  it("walks through the disclosures, fills a test candidate, and signs", async () => {
    const submitted: unknown[] = [];
    await mount(form, submitted);
    expect(container.textContent).toContain("Test mode · Checkr staging");
    expect(
      [...container.querySelectorAll(".screeningSteps li")].map(
        (step) => step.textContent,
      ),
    ).toEqual([
      "1Your rights",
      "2Disclosure",
      "3Your details",
      "4State notices",
      "5Sign",
    ]);

    expect(heading()).toBe("A Summary of Your Rights");
    expect(button("Continue").disabled).toBe(true);
    await check("I received and read A Summary of Your Rights");
    await proceed();

    expect(heading()).toBe("Disclosure Regarding Background Investigation");
    expect(container.querySelectorAll(".card")).toHaveLength(1);
    expect(container.querySelectorAll(".card input")).toHaveLength(1);
    await check("I read this disclosure.");
    await proceed();

    expect(container.textContent).toContain("Test candidates");
    const homer = [
      ...container.querySelectorAll(".screeningTestCandidates li"),
    ].find((row) => row.textContent?.includes("Homer Simpson"));
    expect(homer?.textContent).toContain("Clear");
    const fill = homer?.querySelector("button");
    await act(async () => fill?.click());
    const value = (label: string) =>
      [...container.querySelectorAll("label.field")]
        .find((field) => field.textContent?.startsWith(label))
        ?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select")
        ?.value;
    expect(value("Legal first name")).toBe("Homer");
    expect(value("Social Security number")).toBe("110-11-1100");
    expect(value("Driver’s license number")).toBe("M2233344");
    expect(value("State you live in")).toBe("CA");
    await proceed();

    expect(heading()).toBe("State notices");
    expect(container.textContent).toContain("California notice text.");
    expect(container.textContent).not.toContain("New York notice");
    expect(button("Continue").disabled).toBe(true);
    await check("I received the California notice.");
    await check("Send me a free copy of the report.");
    await proceed();

    expect(heading()).toBe("Authorization");
    expect(
      container.querySelector<HTMLInputElement>(".screeningSignature")?.value,
    ).toBe("Homer Simpson");
    await check("I agree to use electronic records");
    await check("I authorize this background check.");
    await proceed("Sign and submit");

    expect(submitted).toEqual([
      {
        acknowledgments: {
          disclosure: true,
          stateNotices: ["CA"],
          summaryOfRights: true,
        },
        candidate: {
          dob: "1983-02-10",
          driverLicenseNumber: "M2233344",
          driverLicenseState: "CA",
          firstName: "Homer",
          lastName: "Simpson",
          middleName: "",
          noMiddleName: true,
          phone: expect.stringMatching(/^2025550[1]\d\d$/),
          ssn: "110-11-1100",
          zipcode: "94088",
        },
        copyRequested: true,
        disclosureFingerprint: "shown-wording",
        requestRevision: "2026-10-19T12:00:00.000Z",
        residenceState: "CA",
        signature: {
          authorize: true,
          electronicRecords: true,
          name: "Homer Simpson",
        },
      },
    ]);
    expect(heading()).toBe("Background check submitted");
  });

  it("skips state notices and test candidates when neither applies", async () => {
    await mount(
      {
        ...form,
        testCandidates: null,
        workLocation: { city: null, state: "TX" },
      },
      [],
    );
    expect(container.textContent).not.toContain("Test mode");
    expect(
      [...container.querySelectorAll(".screeningSteps li")].map(
        (step) => step.textContent,
      ),
    ).toEqual(["1Your rights", "2Disclosure", "3Your details", "4Sign"]);
    await check("I received and read A Summary of Your Rights");
    await proceed();
    await check("I read this disclosure.");
    await proceed();
    expect(container.textContent).not.toContain("Test candidates");
  });
});
