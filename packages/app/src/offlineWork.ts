import type { AuditTemplate } from "@balebase/validators/audits";
import type { IssueInput } from "@balebase/validators/issues";
import {
  changeOfflineWorkspace,
  type OfflineJob,
  type OfflineWorkspace,
} from "./offlineStore";

function required(workspace: OfflineWorkspace | undefined) {
  if (!workspace) throw new Error("Download a checklist while online first.");
  return workspace;
}

export function startOfflineAudit(key: string, template: AuditTemplate) {
  const id = crypto.randomUUID();
  return changeOfflineWorkspace(key, (current) => {
    const workspace = required(current);
    workspace.audits.push({
      id,
      startedAt: new Date().toISOString(),
      template,
      responses: {},
      queued: false,
    });
    return workspace;
  }).then(() => id);
}

export function saveOfflineAnswer(
  key: string,
  id: string,
  itemId: string,
  value: string,
) {
  return changeOfflineWorkspace(key, (current) => {
    const workspace = required(current);
    const audit = workspace.audits.find((entry) => entry.id === id);
    if (!audit || audit.queued)
      throw new Error("This audit has already been queued.");
    audit.responses[itemId] = value;
    return workspace;
  });
}

export function queueOfflineAudit(key: string, id: string) {
  return changeOfflineWorkspace(key, (current) => {
    const workspace = required(current);
    const audit = workspace.audits.find((entry) => entry.id === id);
    if (!audit || audit.queued) return workspace;
    if (
      !audit.template.definition.sections.every((section) =>
        section.items.every(
          (item) => !item.required || audit.responses[item.id]?.trim(),
        ),
      )
    ) {
      throw new Error("Complete every required item first.");
    }
    audit.queued = true;
    workspace.jobs.push(
      job(
        {
          id,
          type: "audit",
          templateId: audit.template.id,
          templateVersion: audit.template.version,
          startedAt: audit.startedAt,
          completedAt: new Date().toISOString(),
          responses: { ...audit.responses },
        },
        [],
      ),
    );
    return workspace;
  });
}

export async function createOfflineIssue(
  key: string,
  input: IssueInput,
  files: File[],
  target?: { auditId: string; itemId: string },
) {
  if (!input.title.trim()) throw new Error("Enter an issue title.");
  if (files.length > 10) throw new Error("Issues are limited to ten images.");
  if (
    files.some(
      (file) =>
        !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
          file.type,
        ) ||
        file.size > 10 * 1024 * 1024 ||
        !file.size,
    )
  ) {
    throw new Error("Choose JPEG, PNG, GIF, or WebP images up to 10 MB each.");
  }
  const id = crypto.randomUUID();
  const images = files.map((file) => ({
    id: crypto.randomUUID(),
    filename: file.name,
    file,
  }));
  return changeOfflineWorkspace(
    key,
    (current) => {
      const workspace = required(current);
      if (
        target &&
        !workspace.audits.some((audit) => audit.id === target.auditId)
      )
        throw new Error("The local audit is missing.");
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
      workspace.jobs.push(job(operation, target ? [target.auditId] : []));
      for (const image of images)
        workspace.jobs.push(
          job(
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

function job(
  operation: OfflineJob["operation"],
  dependsOn: string[],
): OfflineJob {
  return {
    id: operation.id,
    operation,
    dependsOn,
    status: "pending",
    attempts: 0,
    retryAt: 0,
  };
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
