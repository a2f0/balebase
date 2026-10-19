import type { CheckrCandidateDetails } from "./checkr";
import { requiredStateNotices } from "./screeningDisclosures";

export interface ScreeningSubmission {
  candidate: Omit<CheckrCandidateDetails, "email">;
  copyRequested: boolean;
  residenceState: string;
  signatureName: string;
  stateNotices: string[];
}

const usStates = new Set(
  "AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split(
    " ",
  ),
);

/** A two-letter US state or DC code. */
export function isUsStateCode(value: unknown): value is string {
  return typeof value === "string" && usStates.has(value);
}

type Candidate = ScreeningSubmission["candidate"];

/**
 * Checks the screening form against the disclosures in effect, by their
 * fingerprint, and the acknowledgments its work location requires. Returns the
 * details to send to Checkr, or a message for the person.
 */
export function parseScreeningSubmission(
  body: unknown,
  workState: string,
  today: string,
  disclosureFingerprint: string,
): ScreeningSubmission | { error: string } {
  if (!isRecord(body)) return { error: "Complete the screening form." };
  const form = fields<
    | "acknowledgments"
    | "candidate"
    | "copyRequested"
    | "disclosureFingerprint"
    | "residenceState"
    | "signature"
  >(body);
  // The person signs only the wording they were shown.
  if (form.disclosureFingerprint !== disclosureFingerprint) {
    return {
      error:
        "These disclosures changed after you opened the form. Reload the page to review the current version.",
    };
  }
  const acknowledgments = fields<
    "disclosure" | "stateNotices" | "summaryOfRights"
  >(form.acknowledgments);
  if (
    acknowledgments.summaryOfRights !== true ||
    acknowledgments.disclosure !== true
  ) {
    return {
      error:
        "Acknowledge the summary of your rights and the disclosure before submitting.",
    };
  }
  const candidate = parseCandidate(form.candidate, today);
  if ("error" in candidate) return candidate;
  if (!isUsStateCode(form.residenceState)) {
    return { error: "Choose the state you live in." };
  }
  const required = requiredStateNotices(workState, form.residenceState);
  const acknowledged = Array.isArray(acknowledgments.stateNotices)
    ? acknowledgments.stateNotices
    : [];
  if (
    acknowledged.length !== required.length ||
    !required.every((state) => acknowledged.includes(state))
  ) {
    return { error: "Acknowledge each state notice before submitting." };
  }
  const signatureName = parseSignature(form.signature, candidate);
  if (typeof signatureName !== "string") return signatureName;
  return {
    candidate,
    copyRequested: form.copyRequested === true,
    residenceState: form.residenceState,
    signatureName,
    stateNotices: required,
  };
}

function parseCandidate(
  value: unknown,
  today: string,
): Candidate | { error: string } {
  const candidate = fields<
    | "dob"
    | "driverLicenseNumber"
    | "driverLicenseState"
    | "firstName"
    | "lastName"
    | "middleName"
    | "noMiddleName"
    | "phone"
    | "ssn"
    | "zipcode"
  >(value);
  const firstName = name(candidate.firstName, 1);
  const lastName = name(candidate.lastName, 2);
  const noMiddleName = candidate.noMiddleName === true;
  const middleName = noMiddleName ? null : name(candidate.middleName, 1);
  if (!firstName || !lastName || (!noMiddleName && !middleName)) {
    return {
      error:
        "Enter your legal first and last name, and your middle name or that you have none, in the letters on your government ID.",
    };
  }
  const dob = birthDate(candidate.dob, today);
  if (!dob) return { error: "Enter a valid date of birth." };
  const ssn = socialSecurityNumber(candidate.ssn);
  if (!ssn) return { error: "Enter a 9-digit Social Security number." };
  const zipcode = candidate.zipcode;
  if (typeof zipcode !== "string" || !/^\d{5}$/.test(zipcode)) {
    return { error: "Enter your 5-digit ZIP code." };
  }
  const phone = phoneNumber(candidate.phone);
  if (phone === undefined) return { error: "Enter a 10-digit phone number." };
  const license = driverLicense(
    candidate.driverLicenseNumber,
    candidate.driverLicenseState,
  );
  if (!license) {
    return {
      error:
        "Enter both your driver's license number and its state, or leave both blank.",
    };
  }
  return {
    dob,
    driverLicenseNumber: license.number,
    driverLicenseState: license.state,
    firstName,
    lastName,
    middleName,
    phone,
    ssn,
    zipcode,
  };
}

/** The typed signature, which must include the legal first and last name. */
function parseSignature(value: unknown, candidate: Candidate) {
  const signature = fields<"authorize" | "electronicRecords" | "name">(value);
  if (signature.electronicRecords !== true || signature.authorize !== true) {
    return {
      error:
        "Agree to sign electronically and authorize the background check to submit.",
    };
  }
  const signed =
    typeof signature.name === "string"
      ? signature.name.trim().replace(/\s+/g, " ")
      : "";
  const lower = signed.toLowerCase();
  if (
    !signed ||
    signed.length > 200 ||
    !latinName.test(signed) ||
    !lower.includes(candidate.firstName.toLowerCase()) ||
    !lower.includes(candidate.lastName.toLowerCase())
  ) {
    return { error: "Type your full legal name to sign." };
  }
  return signed;
}

// Latin letters, including accented ones, as on US government records. The
// signed authorization PDF renders exactly these, so no name is lost in it.
const latinName = /^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF '.,-]+$/;

function name(value: unknown, minimum: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length >= minimum &&
    trimmed.length <= 50 &&
    /[A-Za-z\u00C0-\u00FF]/.test(trimmed) &&
    latinName.test(trimmed)
    ? trimmed
    : null;
}

function birthDate(value: unknown, today: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value &&
    value >= "1900-01-01" &&
    value < today
    ? value
    : null;
}

function socialSecurityNumber(value: unknown) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s-]/g, "");
  return /^\d{9}$/.test(digits)
    ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
    : null;
}

/** A US phone number as digits, null when left blank, undefined if invalid. */
function phoneNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^\d{10}$/.test(digits) ? digits : undefined;
}

function driverLicense(number: unknown, state: unknown) {
  const blank = (value: unknown) =>
    value === undefined || value === null || value === "";
  if (blank(number) && blank(state)) return { number: null, state: null };
  if (
    typeof number !== "string" ||
    !/^[A-Za-z0-9*-]{1,30}$/.test(number.trim()) ||
    !isUsStateCode(state)
  ) {
    return null;
  }
  return { number: number.trim().toUpperCase(), state };
}

function fields<Key extends string>(value: unknown) {
  return (isRecord(value) ? value : {}) as Partial<Record<Key, unknown>>;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
