import {
  type employeeFormsRoutes,
  screeningMessages,
} from "@balebase/validators/employeeForms";
import type { z } from "zod";
import type { CheckrCandidateDetails } from "./checkr";
import { requiredStateNotices } from "./screeningDisclosures";

export interface ScreeningSubmission {
  candidate: Omit<CheckrCandidateDetails, "email">;
  copyRequested: boolean;
  residenceState: string;
  signatureName: string;
  stateNotices: string[];
}

type SubmittedForm = z.output<typeof employeeFormsRoutes.submitScreening.body>;

/**
 * Checks a screening form the contract accepted against the disclosures in
 * effect, by their fingerprint, today's date, and the acknowledgments its
 * work location requires. Returns the details to send to Checkr, or a
 * message for the person.
 */
export function parseScreeningSubmission(
  form: SubmittedForm,
  workState: string,
  today: string,
  disclosureFingerprint: string,
): ScreeningSubmission | { error: string } {
  // The person signs only the wording they were shown.
  if (form.disclosureFingerprint !== disclosureFingerprint) {
    return { error: screeningMessages.disclosuresChanged };
  }
  if (form.candidate.dob >= today) {
    return { error: screeningMessages.birthDate };
  }
  const required = requiredStateNotices(workState, form.residenceState);
  const acknowledged = form.acknowledgments.stateNotices ?? [];
  if (
    acknowledged.length !== required.length ||
    !required.every((state) => acknowledged.includes(state))
  ) {
    return { error: screeningMessages.stateNotices };
  }
  return {
    candidate: form.candidate,
    copyRequested: form.copyRequested === true,
    residenceState: form.residenceState,
    signatureName: form.signature.name,
    stateNotices: required,
  };
}
