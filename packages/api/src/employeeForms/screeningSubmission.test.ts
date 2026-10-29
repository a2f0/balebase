import { describe, expect, it } from "bun:test";
import { employeeFormsRoutes } from "@balebase/validators/employeeForms";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseScreeningSubmission } from "./screeningSubmission";

/** Reads a form as the submit route does: through the contract, then the API's checks. */
function submit(body: unknown) {
  const parsed = employeeFormsRoutes.submitScreening.body.safeParse(body);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  return parseScreeningSubmission(parsed.data, "TX", "2026-10-19", "shown");
}

function form(name: { first: string; last: string; signature: string }) {
  return {
    acknowledgments: {
      disclosure: true,
      stateNotices: [],
      summaryOfRights: true,
    },
    candidate: {
      dob: "1983-02-10",
      firstName: name.first,
      lastName: name.last,
      noMiddleName: true,
      ssn: "110111100",
      zipcode: "94088",
    },
    disclosureFingerprint: "shown",
    requestRevision: "2026-10-01T00:00:00.000Z",
    residenceState: "TX",
    signature: {
      authorize: true,
      electronicRecords: true,
      name: name.signature,
    },
  };
}

describe("screening submissions", () => {
  it("accepts accented Latin names and normalizes the details", () => {
    const parsed = submit(
      form({
        first: "José  Ñúñez",
        last: "O'Brien-Smith",
        signature: "José Ñúñez O'Brien-Smith",
      }),
    );
    expect(parsed).toMatchObject({
      candidate: {
        firstName: "José Ñúñez",
        lastName: "O'Brien-Smith",
        middleName: null,
        ssn: "110-11-1100",
      },
      signatureName: "José Ñúñez O'Brien-Smith",
      stateNotices: [],
    });
  });

  it("rejects names Checkr's candidate API does not accept", () => {
    for (const name of [
      { first: "李", last: "雷雷", signature: "李 雷雷" },
      { first: "Nguyen", last: "Van", signature: "Nguyễn Van" },
    ]) {
      expect(submit(form(name))).toHaveProperty("error");
    }
  });

  it("only passes names the authorization PDF's font can draw", async () => {
    const font = await (await PDFDocument.create()).embedFont(
      StandardFonts.Helvetica,
    );
    const drawable = new Set(font.getCharacterSet());
    const signed = new Set<string>();
    for (let code = 32; code <= 0xffff; code += 1) {
      const name = `Al${String.fromCharCode(code)}x`;
      const parsed = submit(
        form({ first: name, last: "Lee", signature: `${name} Lee` }),
      );
      if ("error" in parsed) continue;
      for (const character of parsed.signatureName +
        parsed.candidate.firstName) {
        signed.add(character);
      }
    }
    expect(signed.size).toBeGreaterThan(60);
    expect(
      [...signed].filter(
        (character) => !drawable.has(character.codePointAt(0) ?? 0),
      ),
    ).toEqual([]);
  });
});
