import type { Bindings } from "../types";

interface CheckrCandidate {
  id: string;
  report_ids?: string[];
}

interface CheckrReport {
  candidate_id?: string;
  id: string;
  includes_canceled?: boolean;
  result: string | null;
  status: string;
}

interface CheckrPackageList {
  data: Array<{ screenings?: Array<{ type?: string }>; slug?: string }>;
}

/** What the person entered on the screening form, already validated. */
export interface CheckrCandidateDetails {
  dob: string;
  driverLicenseNumber: string | null;
  driverLicenseState: string | null;
  email: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  phone: string | null;
  ssn: string;
  zipcode: string;
}

export class CheckrRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Checkr's own explanation, such as which field it rejected. */
    readonly detail: string,
  ) {
    super(message);
  }
}

// Checkr's self-hosted flow does not support credit screenings, so only
// background checks are ordered through Checkr; managers track credit checks.
export function checkrPackage(env: Bindings) {
  return env.CHECKR_BACKGROUND_PACKAGE;
}

export function checkrConfigured(env: Bindings, kind: string) {
  return Boolean(
    kind === "background_check" && env.CHECKR_API_KEY && checkrPackage(env),
  );
}

/** Checkr staging completes reports only for its mocked candidates. */
export function checkrTestMode(env: Bindings) {
  return env.CHECKR_ENV !== "production";
}

export async function createCheckrCandidate(
  env: Bindings,
  details: CheckrCandidateDetails,
  requirementId: string,
  copyRequested: boolean,
  idempotencyKey: string,
) {
  const body = new URLSearchParams({
    custom_id: requirementId,
    dob: details.dob,
    email: details.email,
    first_name: details.firstName,
    last_name: details.lastName,
    ssn: details.ssn,
    zipcode: details.zipcode,
  });
  if (details.middleName) body.set("middle_name", details.middleName);
  else body.set("no_middle_name", "true");
  if (details.phone) body.set("phone", details.phone);
  if (details.driverLicenseNumber && details.driverLicenseState) {
    body.set("driver_license_number", details.driverLicenseNumber);
    body.set("driver_license_state", details.driverLicenseState);
  }
  if (copyRequested) body.set("copy_requested", "true");
  return checkrRequest<CheckrCandidate>(env, "/candidates", {
    body,
    headers: { "Idempotency-Key": idempotencyKey },
    method: "POST",
  });
}

export async function getCheckrCandidate(env: Bindings, id: string) {
  return checkrRequest<CheckrCandidate>(
    env,
    `/candidates/${encodeURIComponent(id)}`,
  );
}

/** Attaches the signed authorization, which Checkr requires before a report. */
export async function uploadCheckrConsent(
  env: Bindings,
  candidateId: string,
  pdf: Uint8Array,
  filename: string,
  idempotencyKey: string,
) {
  const body = new FormData();
  body.set("type", "consent");
  body.set("file", new File([pdf], filename, { type: "application/pdf" }));
  return checkrRequest<{ id: string }>(
    env,
    `/candidates/${encodeURIComponent(candidateId)}/documents`,
    { body, headers: { "Idempotency-Key": idempotencyKey }, method: "POST" },
  );
}

export async function createCheckrReport(
  env: Bindings,
  candidateId: string,
  packageSlug: string,
  state: string,
  city: string,
  idempotencyKey: string,
) {
  const body = new URLSearchParams({
    candidate_id: candidateId,
    package: packageSlug,
    "work_locations[][country]": "US",
    "work_locations[][state]": state,
  });
  if (city) body.set("work_locations[][city]", city);
  return checkrRequest<CheckrReport>(env, "/reports", {
    body,
    headers: { "Idempotency-Key": idempotencyKey },
    method: "POST",
  });
}

export async function getCheckrReport(env: Bindings, id: string) {
  return checkrRequest<CheckrReport>(env, `/reports/${encodeURIComponent(id)}`);
}

/**
 * The screening types in a package, such as `motor_vehicle_report`, or null
 * when Checkr does not list it.
 */
export async function checkrPackageScreenings(
  env: Bindings,
  packageSlug: string,
) {
  const packages = await checkrRequest<CheckrPackageList>(
    env,
    "/packages?per_page=100",
  );
  const match = packages.data.find(({ slug }) => slug === packageSlug);
  return match
    ? (match.screenings ?? []).flatMap(({ type }) => (type ? [type] : []))
    : null;
}

// Checkr signs each webhook with an HMAC-SHA256 hex digest of the compact
// JSON body, keyed with the account's API key.
export async function verifyCheckrWebhook(
  payload: BufferSource,
  signature: string | undefined,
  apiKey: string,
) {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiKey),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  const expected = Uint8Array.from(signature.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  return crypto.subtle.verify("HMAC", key, expected, payload);
}

async function checkrRequest<T>(
  env: Bindings,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!env.CHECKR_API_KEY) throw new Error("Checkr is not configured.");
  const host =
    env.CHECKR_ENV === "production"
      ? "https://api.checkr.com/v1"
      : "https://api.checkr-staging.com/v1";
  const response = await fetch(`${host}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${btoa(`${env.CHECKR_API_KEY}:`)}`,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
    } | null;
    const reason = payload?.message ?? payload?.error;
    const detail =
      typeof reason === "string"
        ? reason
        : Array.isArray(reason) &&
            reason.every((item) => typeof item === "string")
          ? reason.join(" ")
          : "Please check the package and account settings.";
    throw new CheckrRequestError(
      `Checkr request failed (${response.status}): ${detail}`,
      response.status,
      detail,
    );
  }
  return response.json() as Promise<T>;
}
