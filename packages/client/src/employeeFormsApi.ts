import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";
import { saveFile } from "./saveFile";

export type EmployeeRequirementKind =
  | "form"
  | "background_check"
  | "credit_check";
export type EmployeeRequirementStatus =
  | "pending"
  | "in_progress"
  | "submitted"
  | "complete";

export interface EmployeeRequirement {
  checkrAvailable: boolean;
  /** Checkr's report status once the person submitted, such as pending. */
  checkrReportStatus: string | null;
  /** Requested and waiting for the person to submit their details. */
  checkrRequested: boolean;
  checkrResult: string | null;
  checkrSubmitting: boolean;
  checkrWorkLocation: { city: string | null; state: string } | null;
  /** The signed-in person can submit this check's screening form. */
  canSubmitCheckr: boolean;
  completedAt: string | null;
  documentFilename: string | null;
  documentRevision: number;
  documentSize: number | null;
  dueDate: string;
  hasCheckrConsent: boolean;
  hasDocument: boolean;
  id: string;
  invitationId: string | null;
  invitationStatus: string | null;
  kind: EmployeeRequirementKind;
  memberId: string | null;
  status: EmployeeRequirementStatus;
  targetEmail: string | null;
  targetName: string | null;
  title: string;
}

export interface RequirementDraft {
  id: string;
  dueDate: string;
  kind: EmployeeRequirementKind;
  title: string;
}

const endpoint = `${apiUrl}/api/employee-forms`;

export async function listEmployeeRequirements() {
  const response = await fetchApi(endpoint, { credentials: "include" });
  return (
    await parseResponse<{ requirements: EmployeeRequirement[] }>(response)
  ).requirements;
}

export async function createEmployeeRequirements(
  target: { invitationId: string } | { memberId: string },
  requirements: RequirementDraft[],
) {
  const response = await fetchApi(endpoint, {
    body: JSON.stringify({ ...target, requirements }),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return parseResponse<{ ids: string[] }>(response);
}

export async function updateEmployeeRequirement(
  id: string,
  update: {
    documentRevision?: number;
    dueDate?: string;
    status?: EmployeeRequirementStatus;
  },
) {
  const response = await fetchApi(`${endpoint}/${encodeURIComponent(id)}`, {
    body: JSON.stringify(update),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  return parseResponse<{ ok: boolean }>(response);
}

export async function deleteEmployeeRequirement(id: string) {
  const response = await fetchApi(`${endpoint}/${encodeURIComponent(id)}`, {
    credentials: "include",
    method: "DELETE",
  });
  return parseResponse<{ ok: boolean }>(response);
}

export async function uploadEmployeeForm(id: string, file: File) {
  const body = new FormData();
  body.set("file", file);
  const response = await fetchApi(
    `${endpoint}/${encodeURIComponent(id)}/document`,
    {
      body,
      credentials: "include",
      method: "POST",
    },
  );
  return parseResponse<{ filename: string; status: string }>(response);
}

export async function requestCheckrScreening(
  id: string,
  state: string,
  city: string,
) {
  const response = await fetchApi(
    `${endpoint}/${encodeURIComponent(id)}/checkr/request`,
    {
      body: JSON.stringify({ city, state }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  return parseResponse<{ emailed: boolean }>(response);
}

interface DisclosureSection {
  paragraphs: string[];
  title: string;
}

/** One of Checkr's mocked staging candidates and the result it produces. */
export interface CheckrTestCandidate {
  dob: string;
  driverLicenseNumber: string;
  driverLicenseState: string;
  expectedResult: "clear" | "consider";
  findings: string[];
  firstName: string;
  id: string;
  lastName: string;
  location: string;
  middleName: string | null;
  ssn: string;
  state: string;
  zipcode: string;
}

export interface ScreeningForm {
  candidate: { email: string; name: string };
  disclosures: {
    authorization: DisclosureSection;
    disclosure: DisclosureSection;
    electronicRecords: DisclosureSection;
    stateNotices: Record<string, DisclosureSection & { offersCopy: boolean }>;
    summaryOfRights: DisclosureSection;
    version: string;
  };
  organizationName: string;
  requiresDriverLicense: boolean;
  summaryOfRightsUrl: string;
  /** Present only while Checkr is in staging. */
  testCandidates: CheckrTestCandidate[] | null;
  title: string;
  workLocation: { city: string | null; state: string };
}

export interface ScreeningSubmission {
  acknowledgments: {
    disclosure: boolean;
    stateNotices: string[];
    summaryOfRights: boolean;
  };
  candidate: {
    dob: string;
    driverLicenseNumber: string;
    driverLicenseState: string;
    firstName: string;
    lastName: string;
    middleName: string;
    noMiddleName: boolean;
    phone: string;
    ssn: string;
    zipcode: string;
  };
  copyRequested: boolean;
  residenceState: string;
  signature: { authorize: boolean; electronicRecords: boolean; name: string };
}

export async function getScreeningForm(id: string) {
  const response = await fetchApi(
    `${endpoint}/${encodeURIComponent(id)}/checkr/form`,
    { credentials: "include" },
  );
  return parseResponse<ScreeningForm>(response);
}

export async function submitScreening(
  id: string,
  submission: ScreeningSubmission,
) {
  const response = await fetchApi(
    `${endpoint}/${encodeURIComponent(id)}/checkr/submit`,
    {
      body: JSON.stringify(submission),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  return parseResponse<{ status: string }>(response);
}

export async function refreshCheckrScreening(id: string) {
  const response = await fetchApi(
    `${endpoint}/${encodeURIComponent(id)}/checkr/refresh`,
    {
      credentials: "include",
      method: "POST",
    },
  );
  return parseResponse<{
    reportStatus: string;
    result: string | null;
  }>(response);
}

/** Saves the signed background check authorization behind a report. */
export async function downloadScreeningConsent(id: string) {
  const response = await fetchApi(
    `${endpoint}/${encodeURIComponent(id)}/checkr/consent`,
    { credentials: "include" },
  );
  if (!response.ok) {
    await parseResponse(response);
    throw new Error("Could not download the authorization.");
  }
  if (
    !(await saveFile(
      await response.blob(),
      "background-check-authorization.pdf",
    ))
  ) {
    throw new Error("Saving the authorization was canceled.");
  }
}

export async function downloadEmployeeForm(id: string, filename: string) {
  const response = await fetchApi(
    `${endpoint}/${encodeURIComponent(id)}/document`,
    {
      credentials: "include",
    },
  );
  if (!response.ok) {
    await parseResponse(response);
    throw new Error("Could not download the form.");
  }
  const revision = Number(response.headers.get("X-Document-Revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("The downloaded form has no review version.");
  }
  if (!(await saveFile(await response.blob(), filename))) {
    throw new Error("Saving the form was canceled.");
  }
  return revision;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(
    body?.error ?? `Request failed with status ${response.status}.`,
  );
}
