import { z } from "zod";
import { calendarDate, optionalText, requiredText } from "./fields";
import { route } from "./route";
import { employeeRequirementLimits, usStateCodes } from "./rules";

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

/** Blank optional fields may be sent empty. */
const ScreeningSubmissionSchema = z.object({
  acknowledgments: z.object({
    disclosure: z.boolean(),
    /** Each state notice the form showed for the work and home states. */
    stateNotices: z.array(z.string()).optional(),
    summaryOfRights: z.boolean(),
  }),
  candidate: z.object({
    dob: z.string(),
    driverLicenseNumber: z.string().nullish(),
    driverLicenseState: z.string().nullish(),
    firstName: z.string(),
    lastName: z.string(),
    middleName: z.string().optional(),
    noMiddleName: z.boolean().optional(),
    phone: z.string().nullish(),
    ssn: z.string(),
    zipcode: z.string(),
  }),
  copyRequested: z.boolean().optional(),
  /** Identifies the exact wording the person read; the API requires it. */
  disclosureFingerprint: z.string(),
  requestRevision: z.string(),
  residenceState: z.string(),
  signature: z.object({
    authorize: z.boolean(),
    electronicRecords: z.boolean(),
    name: z.string(),
  }),
});
export type ScreeningSubmission = z.infer<typeof ScreeningSubmissionSchema>;

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
