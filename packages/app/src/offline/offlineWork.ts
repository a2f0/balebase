import type { FormTemplate } from "@balebase/validators/forms";
import {
  issueImageProblem,
  maxIssueImages,
} from "@balebase/validators/issueRules";
import type { IssueInput } from "@balebase/validators/issues";
import {
  formWrites,
  type OfflineFormEvent,
  offlineFormTransition,
} from "./offlineFormState";
import {
  changeOfflineWorkspace,
  type OfflineWorkspace,
  pendingJob,
} from "./offlineStore";

function required(workspace: OfflineWorkspace | undefined) {
  if (!workspace)
    throw new Error(
      "This device is not ready for forms yet. Connect and sign in first.",
    );
  return workspace;
}

/**
 * Starts a form on this device for `projectId` from `template`, which it
 * keeps: the form is finished and synced against that version whatever
 * happens to the template meanwhile. Resolves the form's ID.
 */
export function startOfflineForm(
  key: string,
  template: FormTemplate,
  projectId: string,
) {
  const id = crypto.randomUUID();
  return changeOfflineWorkspace(key, (current) => {
    const workspace = required(current);
    workspace.forms.push({
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

/** Moves the form by `event`, queueing the server writes it calls for. */
export function applyOfflineFormEvent(
  workspace: OfflineWorkspace,
  formId: string,
  event: OfflineFormEvent,
) {
  const index = workspace.forms.findIndex((entry) => entry.id === formId);
  const form = workspace.forms[index];
  if (!form) throw new Error("The local form is missing.");
  const step = offlineFormTransition(
    form,
    formWrites(workspace.jobs, formId),
    event,
  );
  workspace.forms[index] = step.form;
  workspace.jobs.push(...step.queue);
  return workspace;
}

/**
 * Saves an answer on this device, given at `at` over `base`: the version of
 * the server answer shown when it was given (`answerBase`). Both are taken
 * when the answer is given, so a write retried later keeps them.
 */
export function saveOfflineAnswer(
  key: string,
  id: string,
  itemId: string,
  answer: { at: string; base: string | null; value: string },
) {
  return changeOfflineWorkspace(key, (current) =>
    applyOfflineFormEvent(required(current), id, {
      ...answer,
      itemId,
      type: "answered",
    }),
  );
}

/**
 * Shares a draft with the server as an in-progress form. From then on its
 * answers sync both ways whenever the device is online.
 */
export function saveOfflineProgress(key: string, id: string) {
  return changeOfflineWorkspace(key, (current) =>
    applyOfflineFormEvent(required(current), id, { type: "shared" }),
  );
}

/** Seals the form and queues its completion to sync. */
export function completeOfflineForm(key: string, id: string) {
  return changeOfflineWorkspace(key, (current) =>
    applyOfflineFormEvent(required(current), id, {
      completedAt: new Date().toISOString(),
      saveId: crypto.randomUUID(),
      type: "completed",
    }),
  );
}

/**
 * Saves an issue raised on a form's item, with its photos, on this device.
 * The issue syncs onto the server's form, so a draft is shared with the
 * server along with it.
 */
export async function createOfflineIssue(
  key: string,
  input: IssueInput,
  files: File[],
  target: { formId: string; itemId: string },
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
      const workspace = applyOfflineFormEvent(
        required(current),
        target.formId,
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
      workspace.jobs.push(pendingJob(operation, [target.formId]));
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
