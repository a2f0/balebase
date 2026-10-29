import { ApiError } from "@balebase/api-client";
import type { AuditIssueInput } from "@balebase/validators/audits";
import {
  issueImageProblem,
  maxIssueImages,
} from "@balebase/validators/issueRules";
import { api } from "./shared/apiClient";

type IssueImageUploader = (issueId: string, file: File) => Promise<unknown>;

/**
 * Creates the issue, then attaches its images. Returns a warning when some
 * images could not be attached; the issue exists either way.
 */
export async function createIssueWithImages(
  auditId: string,
  issue: AuditIssueInput,
  images: File[],
  create = api.audits.createIssue,
  upload: IssueImageUploader = api.audits.uploadIssueImage,
) {
  const { issueId } = await create(auditId, issue);
  const failedUploads = (
    await uploadIssueImagesSequentially(issueId, images, upload)
  ).length;
  return failedUploads > 0
    ? `${failedUploads} image${failedUploads === 1 ? "" : "s"} could not be attached. The issue was created.`
    : undefined;
}

type WaitForRetry = (milliseconds: number) => Promise<void>;

const maxIssueImageUploadRetries = 9;
const maxIssueImageRetryDelay = 10_000;

export async function uploadIssueImagesSequentially(
  issueId: string,
  files: File[],
  upload: IssueImageUploader = api.audits.uploadIssueImage,
  wait: WaitForRetry = waitForRetry,
) {
  const failures: unknown[] = [];
  // Keep at most one decoded upload in a Worker isolate for this browser. A
  // user can select ten 10 MB files, so firing them all at once can exhaust the
  // isolate's shared memory before image normalization completes.
  for (const file of files) {
    let retryAttempt = 0;
    while (true) {
      try {
        await upload(issueId, file);
        break;
      } catch (retryCause) {
        const retryDelay = issueImageRetryDelay(retryCause, retryAttempt);
        if (
          retryDelay === undefined ||
          retryAttempt >= maxIssueImageUploadRetries
        ) {
          failures.push(retryCause);
          break;
        }
        retryAttempt += 1;
        await wait(retryDelay);
      }
    }
  }
  return failures;
}

function issueImageRetryDelay(cause: unknown, retryAttempt: number) {
  if (!(cause instanceof ApiError) || cause.status !== 429) {
    return undefined;
  }
  const header = cause.response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = /^\d+$/.test(header) ? Number(header) : undefined;
  const milliseconds =
    seconds === undefined ? Date.parse(header) - Date.now() : seconds * 1_000;
  if (!Number.isFinite(milliseconds)) return undefined;
  const exponentialDelay = Math.min(
    1_000 * 2 ** retryAttempt,
    maxIssueImageRetryDelay,
  );
  return Math.min(
    Math.max(milliseconds, exponentialDelay),
    maxIssueImageRetryDelay,
  );
}

function waitForRetry(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function appendIssueImageSelection(
  existingFiles: File[],
  selectedFiles: File[],
) {
  const identities = new Set(existingFiles.map(issueImageSelectionKey));
  const additions = selectedFiles.filter((file) => {
    const identity = issueImageSelectionKey(file);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  return (
    issueImageProblem(additions, maxIssueImages - existingFiles.length) ?? [
      ...existingFiles,
      ...additions,
    ]
  );
}

export function issueImageSelectionKey(file: File) {
  return JSON.stringify([
    file.name,
    file.size,
    file.lastModified,
    file.type,
    file.webkitRelativePath,
  ]);
}
