import type { AuditTemplate } from "@balebase/validators/audits";
import {
  issueImageProblem,
  maxIssueImages,
} from "@balebase/validators/issueRules";
import type { IssueInput } from "@balebase/validators/issues";
import {
  auditWrites,
  type OfflineAuditEvent,
  offlineAuditTransition,
} from "./offlineAuditState";
import {
  changeOfflineWorkspace,
  type OfflineWorkspace,
  pendingJob,
} from "./offlineStore";

function required(workspace: OfflineWorkspace | undefined) {
  if (!workspace)
    throw new Error(
      "This device is not ready for audits yet. Connect and sign in first.",
    );
  return workspace;
}

/**
 * Starts an audit on this device for `projectId` from `template`, which it
 * keeps: the audit is finished and synced against that version whatever
 * happens to the form meanwhile. Resolves the audit's ID.
 */
export function startOfflineAudit(
  key: string,
  template: AuditTemplate,
  projectId: string,
) {
  const id = crypto.randomUUID();
  return changeOfflineWorkspace(key, (current) => {
    const workspace = required(current);
    workspace.audits.push({
      id,
      projectId,
      startedAt: new Date().toISOString(),
      template,
      status: "draft",
      server: { answers: {}, revision: 0, status: "in_progress" },
      sending: [],
      local: {},
      replaced: {},
    });
    return workspace;
  }).then(() => id);
}

/** Moves the audit by `event`, queueing the server writes it calls for. */
export function applyOfflineAuditEvent(
  workspace: OfflineWorkspace,
  auditId: string,
  event: OfflineAuditEvent,
) {
  const index = workspace.audits.findIndex((entry) => entry.id === auditId);
  const audit = workspace.audits[index];
  if (!audit) throw new Error("The local audit is missing.");
  const step = offlineAuditTransition(
    audit,
    auditWrites(workspace.jobs, auditId),
    event,
  );
  workspace.audits[index] = step.audit;
  workspace.jobs.push(...step.queue);
  return workspace;
}

/**
 * Saves an answer on this device, given at `at` over `base`: the time of the
 * server answer shown when it was given (`answerBase`). Both are taken when
 * the answer is given, so a write retried later keeps them.
 */
export function saveOfflineAnswer(
  key: string,
  id: string,
  itemId: string,
  answer: { at: string; base: string | null; value: string },
) {
  return changeOfflineWorkspace(key, (current) =>
    applyOfflineAuditEvent(required(current), id, {
      ...answer,
      itemId,
      type: "answered",
    }),
  );
}

/**
 * Shares a draft with the server as an in-progress audit. From then on its
 * answers sync both ways whenever the device is online.
 */
export function saveOfflineProgress(key: string, id: string) {
  return changeOfflineWorkspace(key, (current) =>
    applyOfflineAuditEvent(required(current), id, { type: "shared" }),
  );
}

/** Seals the audit and queues its completion to sync. */
export function completeOfflineAudit(key: string, id: string) {
  return changeOfflineWorkspace(key, (current) =>
    applyOfflineAuditEvent(required(current), id, {
      completedAt: new Date().toISOString(),
      saveId: crypto.randomUUID(),
      type: "completed",
    }),
  );
}

/**
 * Saves an issue raised on an audit's item, with its photos, on this device.
 * The issue syncs onto the server's audit, so a draft is shared with the
 * server along with it.
 */
export async function createOfflineIssue(
  key: string,
  input: IssueInput,
  files: File[],
  target: { auditId: string; itemId: string },
) {
  if (!input.title.trim()) throw new Error("Enter an issue title.");
  const imageProblem = issueImageProblem(files, maxIssueImages);
  if (imageProblem) throw new Error(imageProblem);
  const id = crypto.randomUUID();
  const images = files.map((file) => ({
    id: crypto.randomUUID(),
    filename: file.name,
    file,
  }));
  return changeOfflineWorkspace(
    key,
    (current) => {
      const workspace = applyOfflineAuditEvent(
        required(current),
        target.auditId,
        { type: "issueRaised" },
      );
      const operation = {
        ...input,
        ...target,
        title: input.title.trim(),
        id,
        type: "issue" as const,
      };
      workspace.issues.push({
        operation,
        images: images.map(({ id: imageId, filename }) => ({
          id: imageId,
          filename,
        })),
      });
      workspace.jobs.push(pendingJob(operation, [target.auditId]));
      for (const image of images)
        workspace.jobs.push(
          pendingJob(
            {
              id: image.id,
              filename: image.filename,
              issueId: id,
              type: "image",
            },
            [id],
          ),
        );
      return workspace;
    },
    images,
  );
}

export function retryOfflineWork(key: string) {
  return changeOfflineWorkspace(key, (current) => {
    const workspace = required(current);
    for (const entry of workspace.jobs) {
      if (entry.status !== "synced") {
        entry.status = "pending";
        entry.retryAt = 0;
        delete entry.error;
      }
    }
    return workspace;
  });
}
