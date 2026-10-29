import { describe, expect, it } from "bun:test";
import { employeeFormsRoutes, screeningMessages } from "./employeeForms";

const schema = employeeFormsRoutes.submitScreening.body;

function form() {
  return {
    acknowledgments: {
      disclosure: true,
      stateNotices: [],
      summaryOfRights: true,
    },
    candidate: {
      dob: "1983-02-10",
      driverLicenseNumber: " m22-33 ",
      driverLicenseState: "CA",
      firstName: " Homer ",
      lastName: "Jay  Simpson",
      middleName: "",
      noMiddleName: true,
      phone: "1 (202) 555-0100",
      ssn: "110 11-1100",
      zipcode: "94088",
    },
    disclosureFingerprint: "shown",
    requestRevision: "2026-10-01T00:00:00.000Z",
    residenceState: "CA",
    signature: {
      authorize: true,
      electronicRecords: true,
      name: " homer  jay simpson ",
    },
  };
}

function refusal(body: unknown) {
  const parsed = schema.safeParse(body);
  return parsed.success ? "accepted" : parsed.error.issues[0]?.message;
}

describe("screening submission", () => {
  it("normalizes the details Checkr receives", () => {
    expect(schema.parse(form())).toMatchObject({
      candidate: {
        driverLicenseNumber: "M22-33",
        driverLicenseState: "CA",
        firstName: "Homer",
        lastName: "Jay Simpson",
        middleName: null,
        phone: "2025550100",
        ssn: "110-11-1100",
      },
      signature: { name: "homer jay simpson" },
    });
    const blank = form();
    Object.assign(blank.candidate, {
      driverLicenseNumber: "",
      driverLicenseState: null,
      phone: "",
    });
    expect(schema.parse(blank).candidate).toMatchObject({
      driverLicenseNumber: null,
      driverLicenseState: null,
      phone: null,
    });
  });

  it("names the first rule a form breaks", () => {
    const cases: Array<[(body: ReturnType<typeof form>) => unknown, string]> = [
      [
        (body) => ({ ...body, acknowledgments: undefined }),
        "Acknowledge the summary of your rights and the disclosure before submitting.",
      ],
      [
        (body) => {
          body.acknowledgments.summaryOfRights = false;
          return body;
        },
        "Acknowledge the summary of your rights and the disclosure before submitting.",
      ],
      [
        (body) => {
          body.candidate.firstName = "李";
          return body;
        },
        "Enter your legal first and last name, and your middle name or that you have none. Checkr accepts letters A–Z and accented letters such as é or ñ.",
      ],
      [
        (body) => {
          body.candidate.noMiddleName = false;
          return body;
        },
        "Enter your legal first and last name, and your middle name or that you have none. Checkr accepts letters A–Z and accented letters such as é or ñ.",
      ],
      [
        (body) => {
          body.candidate.dob = "1899-12-31";
          return body;
        },
        screeningMessages.birthDate,
      ],
      [
        (body) => {
          body.candidate.ssn = "12345";
          return body;
        },
        "Enter a 9-digit Social Security number.",
      ],
      [
        (body) => {
          body.candidate.zipcode = "9408";
          return body;
        },
        "Enter your 5-digit ZIP code.",
      ],
      [
        (body) => {
          body.candidate.phone = "555-0100";
          return body;
        },
        "Enter a 10-digit phone number.",
      ],
      [
        (body) => {
          body.candidate.driverLicenseState = "";
          return body;
        },
        "Enter both your driver's license number and its state, or leave both blank.",
      ],
      [
        (body) => ({ ...body, residenceState: "XX" }),
        "Choose the state you live in.",
      ],
      [
        (body) => {
          body.signature.authorize = false;
          return body;
        },
        "Agree to sign electronically and authorize the background check to submit.",
      ],
      [
        (body) => {
          body.signature.name = "Someone Else";
          return body;
        },
        "Type your full legal name to sign.",
      ],
      [
        (body) => ({ ...body, disclosureFingerprint: undefined }),
        screeningMessages.disclosuresChanged,
      ],
      [
        (body) => ({ ...body, requestRevision: undefined }),
        screeningMessages.requestChanged,
      ],
    ];
    for (const [change, message] of cases) {
      expect(refusal(change(form()))).toBe(message);
    }
    expect(refusal(form())).toBe("accepted");
  });
});
