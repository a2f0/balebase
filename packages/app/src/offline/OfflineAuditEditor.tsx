import {
  Banner,
  Button,
  Card,
  Field,
  PageSection,
  Select,
} from "@balebase/ui/react";
import { auditLimits } from "@balebase/validators/rules";
import { useState } from "react";
import { guardWorkspaceChange } from "../workspace/navigationGuard";
import { auditRunPath } from "../workspace/workspacePaths";
import { OfflineIssueCreator, OfflineIssueList } from "./OfflineIssues";
import {
  type AuditWriteJob,
  auditWrites,
  unsavedProgress,
} from "./offlineAuditState";
import type { OfflineAudit, OfflineWorkspace } from "./offlineStore";
import { useOfflineAnswers } from "./useOfflineAnswers";

/**
 * Answers an audit on this device, saving each answer here as it is given.
 * Saving progress syncs the answers so far as an in-progress audit, and
 * completing it queues its completion; issues raised on its items sync
 * onto the server's audit.
 */
export function OfflineAuditEditor({
  audit,
  workspace,
  onNavigate,
}: {
  audit: OfflineAudit;
  workspace: OfflineWorkspace;
  onNavigate: (path: string) => void;
}) {
  const [issueItem, setIssueItem] = useState<string>();
  const { responses, pending, sealing, error, answer, save } =
    useOfflineAnswers(audit, workspace.key);
  const writes = auditWrites(workspace.jobs, audit.id);
  const completed = audit.status === "completed";
  return (
    <PageSection title={`Checklist · v${audit.template.version}`}>
      {error && (
        <Banner
          tone="danger"
          actions={
            <Button
              disabled={pending > 0 || completed}
              onClick={() => void save()}
            >
              Retry saving draft
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      <p role="status">
        {pending
          ? "Saving on this device…"
          : error
            ? "Some changes have not been saved."
            : syncStatus(audit, writes)}
      </p>
      {audit.template.definition.sections.map((section) => (
        <Card key={section.id} title={section.title}>
          {section.items.map((item) => (
            <div key={item.id} className="stack">
              <Field
                label={`${item.prompt}${item.required ? " (required)" : ""}`}
              >
                {item.responseType === "text" ? (
                  <textarea
                    className="textarea"
                    maxLength={auditLimits.answer}
                    disabled={completed || sealing}
                    value={responses[item.id] ?? ""}
                    onChange={(event) =>
                      void answer(item.id, event.target.value)
                    }
                  />
                ) : (
                  <Select
                    disabled={completed || sealing}
                    value={responses[item.id] ?? ""}
                    onChange={(event) =>
                      void answer(item.id, event.target.value)
                    }
                  >
                    <option value="" disabled>
                      Choose an answer
                    </option>
                    <option value="pass">Pass</option>
                    <option value="fail">Fail</option>
                    <option value="na">N/A</option>
                  </Select>
                )}
              </Field>
              <Button
                onClick={() =>
                  void guardWorkspaceChange(async () =>
                    setIssueItem(issueItem === item.id ? undefined : item.id),
                  )()
                }
              >
                Raise issue
              </Button>
              {issueItem === item.id && (
                <OfflineIssueCreator
                  workspace={workspace}
                  target={{ auditId: audit.id, itemId: item.id }}
                  onSaved={() => setIssueItem(undefined)}
                />
              )}
            </div>
          ))}
        </Card>
      ))}
      <div className="cluster">
        {!completed && (
          <>
            <Button
              disabled={pending > 0}
              onClick={() => void save("progress")}
            >
              Save progress
            </Button>
            <Button
              busy={pending > 0}
              disabled={pending > 0}
              variant="primary"
              onClick={() => void save("completion")}
            >
              Complete audit
            </Button>
          </>
        )}
        {writes[0]?.status === "synced" && (
          <Button
            variant="ghost"
            onClick={() => onNavigate(auditRunPath(audit.id))}
          >
            Open synced audit
          </Button>
        )}
      </div>
      <OfflineIssueList
        workspace={workspace}
        auditId={audit.id}
        onNavigate={onNavigate}
      />
    </PageSection>
  );
}

/** Where the audit's answers stand against the server's copy. */
function syncStatus(audit: OfflineAudit, writes: AuditWriteJob[]) {
  const blocked = writes.find((job) => job.status === "blocked");
  const synced = writes.every((job) => job.status === "synced");
  switch (audit.status) {
    case "draft":
      return "Draft saved on this device. Save progress to sync it before it is complete.";
    case "inProgress":
      if (blocked) return `Progress not synced. ${blocked.error ?? ""}`.trim();
      if (unsavedProgress(audit, writes))
        return "Saved on this device. Save progress to sync the latest answers.";
      return synced
        ? "Progress synced."
        : "Progress saved. It syncs when this device is online.";
    case "completed":
      return synced
        ? "Completed and synced. Open the synced audit to make further changes."
        : "Completed. It syncs when this device is online; open the synced audit to make further changes.";
  }
}
