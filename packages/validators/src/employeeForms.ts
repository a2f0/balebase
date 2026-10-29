import { z } from "zod";
import { calendarDate, optionalText, requiredText } from "./fields";
import { route } from "./route";
import {
  employeeRequirementLimits,
  isUsStateCode,
  usStateCodes,
} from "./rules";

export const EmployeeRequirementKindSchema = z.enum([
  "form",
  "background_check",
  "credit_check",
]);
export type EmployeeRequirementKind = z.infer<
  typeof EmployeeRequirementKindSchema
>;

export const EmployeeRequirementStatusSchema = z.enum([
  "pending",
  "in_progress",
  "submitted",
  "complete",
]);
export type EmployeeRequirementStatus = z.infer<
  typeof EmployeeRequirementStatusSchema
>;

const EmployeeRequirementSchema = z.object({
  /** The signed-in person can submit this check's screening form. */
  canSubmitCheckr: z.boolean(),
  checkrAvailable: z.boolean(),
  /** Checkr's report status once the person submitted, such as pending. */
  checkrReportStatus: z.string().nullable(),
  /** Requested and waiting for the person to submit their details. */
  checkrRequested: z.boolean(),
  /** Sent to managers only. */
  checkrResult: z.string().nullable(),
  checkrSubmitting: z.boolean(),
  checkrWorkLocation: z
    .object({ city: z.string().nullable(), state: z.string() })
    .nullable(),
  completedAt: z.string().nullable(),
  documentFilename: z.string().nullable(),
  documentRevision: z.number(),
  documentSize: z.number().nullable(),
  dueDate: z.string(),
  hasCheckrConsent: z.boolean(),
  hasDocument: z.boolean(),
  id: z.string(),
  invitationId: z.string().nullable(),
  invitationStatus: z.string().nullable(),
  kind: EmployeeRequirementKindSchema,
  memberId: z.string().nullable(),
  status: EmployeeRequirementStatusSchema,
  targetEmail: z.string().nullable(),
  targetName: z.string().nullable(),
  title: z.string(),
});
export type EmployeeRequirement = z.infer<typeof EmployeeRequirementSchema>;

const requirementsRule = `Choose 1 to ${employeeRequirementLimits.requirements} valid requirements.`;

const EmployeeRequirementInputSchema = z.object(
  {
    dueDate: calendarDate(requirementsRule),
    kind: z.enum(EmployeeRequirementKindSchema.options, {
      error: requirementsRule,
    }),
    title: requiredText(employeeRequirementLimits.title, requirementsRule),
  },
  { error: requirementsRule },
);
export type EmployeeRequirementInput = z.input<
  typeof EmployeeRequirementInputSchema
>;

const targetRule = "Choose one member or invitation.";

/** Requests for one member, or for one pending invitation. */
const EmployeeRequirementCreateSchema = z
  .object(
    {
      invitationId: z.string({ error: targetRule }).optional(),
      memberId: z.string({ error: targetRule }).optional(),
      requirements: z
        .array(EmployeeRequirementInputSchema, { error: requirementsRule })
        .min(1, requirementsRule)
        .max(employeeRequirementLimits.requirements, requirementsRule),
    },
    { error: "A target and requirements are required." },
  )
  .refine(
    ({ invitationId, memberId }) => Boolean(invitationId) !== Boolean(memberId),
    targetRule,
  );

/**
 * A new status, due date, or both. Which statuses a requirement can take
 * depends on its kind and screening, which the API checks.
 */
const EmployeeRequirementUpdateSchema = z
  .object(
    {
      /** A form's status changes only against the revision the manager saw. */
      documentRevision: z.int().min(0).optional(),
      dueDate: calendarDate().optional(),
      status: EmployeeRequirementStatusSchema.optional(),
    },
    { error: "Invalid update." },
  )
  .refine(
    ({ dueDate, status }) => dueDate !== undefined || status !== undefined,
    "Invalid status or due date.",
  );
export type EmployeeRequirementUpdate = z.input<
  typeof EmployeeRequirementUpdateSchema
>;

const DisclosureSectionSchema = z.object({
  paragraphs: z.array(z.string()),
  title: z.string(),
});

/** One of Checkr's mocked staging candidates and the result it produces. */
const CheckrTestCandidateSchema = z.object({
  dob: z.string(),
  driverLicenseNumber: z.string(),
  driverLicenseState: z.string(),
  expectedResult: z.enum(["clear", "consider"]),
  findings: z.array(z.string()),
  firstName: z.string(),
  id: z.string(),
  lastName: z.string(),
  location: z.string(),
  middleName: z.string().nullable(),
  ssn: z.string(),
  state: z.string(),
  zipcode: z.string(),
});
export type CheckrTestCandidate = z.infer<typeof CheckrTestCandidateSchema>;

const ScreeningFormSchema = z.object({
  candidate: z.object({ email: z.string(), name: z.string() }),
  disclosureFingerprint: z.string(),
  disclosures: z.object({
    authorization: DisclosureSectionSchema,
    disclosure: DisclosureSectionSchema,
    electronicRecords: DisclosureSectionSchema,
    /** By state code. */
    stateNotices: z.record(
      z.string(),
      DisclosureSectionSchema.extend({
        /** The state lets the person ask for a free copy of the report. */
        offersCopy: z.boolean(),
      }),
    ),
    summaryOfRights: DisclosureSectionSchema,
    version: z.string(),
  }),
  organizationName: z.string(),
  /** Identifies the request this form answers; submissions must repeat it. */
  requestRevision: z.string(),
  requiresDriverLicense: z.boolean(),
  summaryOfRightsUrl: z.string(),
  /** Present only while Checkr is in staging. */
  testCandidates: z.array(CheckrTestCandidateSchema).nullable(),
  title: z.string(),
  workLocation: z.object({ city: z.string().nullable(), state: z.string() }),
});
export type ScreeningForm = z.infer<typeof ScreeningFormSchema>;

// Checkr's candidate API accepts names only in these characters, documented as
// [a-zA-Z0-9ªµºÀ-ÖØ-öø-ÿ\-'., ]: other scripts, such as Vietnamese "ễ", are
// rejected by Checkr itself. The signed authorization PDF draws every one of
// them, so no accepted name is altered in it.
const checkrName =
  /^[A-Za-z0-9\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF '.,-]+$/;
const checkrLetter =
  /[A-Za-z\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/;

/** Messages the API also answers with, for the checks it makes itself. */
export const screeningMessages = {
  birthDate: "Enter a valid date of birth.",
  disclosuresChanged:
    "These disclosures changed after you opened the form. Reload the page to review the current version.",
  requestChanged:
    "This background check changed after you opened it. Reload the page to review it again.",
  stateNotices: "Acknowledge each state notice before submitting.",
};

const acknowledgeRule =
  "Acknowledge the summary of your rights and the disclosure before submitting.";
const nameRule =
  "Enter your legal first and last name, and your middle name or that you have none. Checkr accepts letters A–Z and accented letters such as é or ñ.";
const birthDateRule = screeningMessages.birthDate;
const ssnRule = "Enter a 9-digit Social Security number.";
const phoneRule = "Enter a 10-digit phone number.";
const licenseRule =
  "Enter both your driver's license number and its state, or leave both blank.";
const signRule =
  "Agree to sign electronically and authorize the background check to submit.";
const signatureNameRule = "Type your full legal name to sign.";
const residenceRule = "Choose the state you live in.";

/** Trims text and makes each run of whitespace one space. */
const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

/** A part of a legal name as Checkr accepts it. */
function checkrNamePart(minimum: number) {
  return z
    .string({ error: nameRule })
    .overwrite(oneLine)
    .min(minimum, nameRule)
    .max(50, nameRule)
    .regex(checkrLetter, nameRule)
    .regex(checkrName, nameRule);
}

/** A checkbox the person must tick. */
function agreed(rule: string) {
  return z.boolean({ error: rule }).refine((ticked) => ticked, rule);
}

/** Both blank, or a license number with its issuing state. */
function driverLicense(number?: string | null, state?: string | null) {
  if (!number && !state) return { number: null, state: null };
  const trimmed = number?.trim() ?? "";
  if (
    !state ||
    !isUsStateCode(state) ||
    !/^[A-Za-z0-9*-]{1,30}$/.test(trimmed)
  ) {
    return null;
  }
  return { number: trimmed.toUpperCase(), state };
}

/** The person's details as Checkr takes them. */
const ScreeningCandidateSchema = z
  .object(
    {
      firstName: checkrNamePart(1),
      lastName: checkrNamePart(2),
      /** Checked only when the person has a middle name. */
      middleName: z.string({ error: nameRule }).optional(),
      noMiddleName: z.boolean().optional(),
      /** The API also refuses today and later. */
      dob: calendarDate(birthDateRule).refine(
        (dob) => dob >= "1900-01-01",
        birthDateRule,
      ),
      ssn: z.string({ error: ssnRule }).transform((ssn, context) => {
        const digits = ssn.replace(/[\s-]/g, "");
        if (/^\d{9}$/.test(digits)) {
          return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
        }
        context.addIssue({ code: "custom", message: ssnRule });
        return z.NEVER;
      }),
      zipcode: z
        .string({ error: "Enter your 5-digit ZIP code." })
        .regex(/^\d{5}$/, "Enter your 5-digit ZIP code."),
      /** Ten digits, or null when left blank. */
      phone: z
        .string({ error: phoneRule })
        .nullish()
        .transform((phone, context) => {
          if (!phone) return null;
          const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
          if (/^\d{10}$/.test(digits)) return digits;
          context.addIssue({ code: "custom", message: phoneRule });
          return z.NEVER;
        }),
      driverLicenseNumber: z.string({ error: licenseRule }).nullish(),
      driverLicenseState: z.string({ error: licenseRule }).nullish(),
    },
    { error: nameRule },
  )
  .transform(
    (
      {
        driverLicenseNumber,
        driverLicenseState,
        middleName,
        noMiddleName,
        ...candidate
      },
      context,
    ) => {
      const middle = noMiddleName
        ? { data: null, success: true as const }
        : checkrNamePart(1).safeParse(middleName);
      const license = driverLicense(driverLicenseNumber, driverLicenseState);
      if (!middle.success || !license) {
        context.addIssue({
          code: "custom",
          message: middle.success ? licenseRule : nameRule,
        });
        return z.NEVER;
      }
      return {
        ...candidate,
        driverLicenseNumber: license.number,
        driverLicenseState: license.state,
        middleName: middle.data,
      };
    },
  );

/**
 * A completed screening form. The API checks the rest: the disclosures and
 * request it answers, the date of birth against today, and the state
 * notices its work location requires. Blank optional fields may be empty.
 */
const ScreeningSubmissionSchema = z
  .object({
    acknowledgments: z.object(
      {
        disclosure: agreed(acknowledgeRule),
        /** Each state notice the form showed for the work and home states. */
        stateNotices: z
          .array(z.string(), { error: screeningMessages.stateNotices })
          .optional(),
        summaryOfRights: agreed(acknowledgeRule),
      },
      { error: acknowledgeRule },
    ),
    candidate: ScreeningCandidateSchema,
    copyRequested: z.boolean().optional(),
    /** Identifies the exact wording the person read. */
    disclosureFingerprint: z.string({
      error: screeningMessages.disclosuresChanged,
    }),
    requestRevision: z.string({ error: screeningMessages.requestChanged }),
    residenceState: z
      .string({ error: residenceRule })
      .refine(isUsStateCode, residenceRule),
    signature: z.object(
      {
        authorize: agreed(signRule),
        electronicRecords: agreed(signRule),
        name: z
          .string({ error: signatureNameRule })
          .overwrite(oneLine)
          .min(1, signatureNameRule)
          .max(200, signatureNameRule)
          .regex(checkrName, signatureNameRule),
      },
      { error: signRule },
    ),
  })
  // The typed signature must include the legal first and last name.
  .refine(
    ({ candidate, signature }) =>
      [candidate.firstName, candidate.lastName].every((part) =>
        signature.name.toLowerCase().includes(part.toLowerCase()),
      ),
    { message: signatureNameRule, path: ["signature", "name"] },
  );
/** What a client sends; the API reads it with names and numbers normalized. */
export type ScreeningSubmission = z.input<typeof ScreeningSubmissionSchema>;

const OkSchema = z.object({ ok: z.literal(true) });

export const employeeFormsRoutes = {
  list: route({
    method: "GET",
    path: "/api/employee-forms",
    /** `me` keeps only the person's own requests, as they see them. */
    query: z.object({ for: z.literal("me").optional() }),
    response: z.object({ requirements: z.array(EmployeeRequirementSchema) }),
  }),
  create: route({
    method: "POST",
    path: "/api/employee-forms",
    body: EmployeeRequirementCreateSchema,
    response: z.object({ ids: z.array(z.string()) }),
  }),
  update: route({
    method: "PATCH",
    path: "/api/employee-forms/:id",
    body: EmployeeRequirementUpdateSchema,
    response: OkSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/employee-forms/:id",
    response: OkSchema,
  }),
  upload: route({
    method: "POST",
    path: "/api/employee-forms/:id/document",
    /** The PDF, JPEG, or PNG as `file`. */
    body: "form",
    response: z.object({
      filename: z.string(),
      status: z.literal("submitted"),
    }),
  }),
  document: route({
    method: "GET",
    path: "/api/employee-forms/:id/document",
    /** X-Document-Revision names the revision downloaded. */
    response: "file",
  }),
  requestScreening: route({
    method: "POST",
    path: "/api/employee-forms/:id/checkr/request",
    body: z.object({
      city: optionalText(requiredText(employeeRequirementLimits.city)),
      state: z.enum(usStateCodes),
    }),
    response: z.object({ emailed: z.boolean() }),
  }),
  screeningForm: route({
    method: "GET",
    path: "/api/employee-forms/:id/checkr/form",
    response: ScreeningFormSchema,
  }),
  submitScreening: route({
    method: "POST",
    path: "/api/employee-forms/:id/checkr/submit",
    body: ScreeningSubmissionSchema,
    response: z.object({ status: z.string() }),
  }),
  refreshScreening: route({
    method: "POST",
    path: "/api/employee-forms/:id/checkr/refresh",
    response: z.object({
      reportStatus: z.string(),
      result: z.string().nullable(),
    }),
  }),
  screeningConsent: route({
    method: "GET",
    path: "/api/employee-forms/:id/checkr/consent",
    /** The signed authorization PDF. */
    response: "file",
  }),
};
