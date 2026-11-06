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
import { OfflineIssueCreator, OfflineIssueList } from "./OfflineIssues";
import type { OfflineAudit, OfflineWorkspace } from "./offlineStore";
import { useOfflineAnswers } from "./useOfflineAnswers";

/**
 * Answers an audit on this device, saving each answer here as it is given.
 * Completing it queues it to sync; issues raised on its items sync after it.
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
  return (
    <PageSection title={`Checklist · v${audit.template.version}`}>
      {error && (
        <Banner
          tone="danger"
          actions={
            <Button
              disabled={pending > 0 || audit.queued}
              onClick={() => void save(false)}
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
            : audit.queued
              ? "Completed. It syncs when this device is online; open the synced audit to make further changes."
              : "Draft saved on this device"}
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
                    disabled={audit.queued || sealing}
                    value={responses[item.id] ?? ""}
                    onChange={(event) =>
                      void answer(item.id, event.target.value)
                    }
                  />
                ) : (
                  <Select
                    disabled={audit.queued || sealing}
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
      {!audit.queued && (
        <Button
          busy={pending > 0}
          disabled={pending > 0}
          variant="primary"
          onClick={() => void save(true)}
        >
          Complete audit
        </Button>
      )}
      <OfflineIssueList
        workspace={workspace}
        auditId={audit.id}
        onNavigate={onNavigate}
      />
    </PageSection>
  );
}
