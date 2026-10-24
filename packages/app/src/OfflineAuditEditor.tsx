import { Banner, Button, Card, Field, PageSection } from "@balebase/ui/react";
import { useState } from "react";
import { guardWorkspaceChange } from "./navigationGuard";
import { OfflineIssueCreator, OfflineIssueList } from "./OfflineIssues";
import type { OfflineAudit, OfflineWorkspace } from "./offlineStore";
import { queueOfflineAudit, saveOfflineAnswer } from "./offlineWork";
import { useUnsavedChanges } from "./unsavedChanges";

export function OfflineAuditEditor({
  audit,
  workspace,
  onBack,
}: {
  audit: OfflineAudit;
  workspace: OfflineWorkspace;
  onBack: () => void;
}) {
  const [issueItem, setIssueItem] = useState<string>();
  const { responses, pending, sealing, error, answer, save } =
    useOfflineAnswers(audit, workspace.key);
  return (
    <PageSection
      title={`${audit.template.name} · v${audit.template.version}`}
      actions={
        <Button
          disabled={pending > 0}
          onClick={() => void guardWorkspaceChange(async () => onBack())()}
        >
          Back to offline work
        </Button>
      }
    >
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
              ? "Completed and queued for sync. Open the synced audit to make further changes."
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
                    maxLength={2000}
                    disabled={audit.queued || sealing}
                    value={responses[item.id] ?? ""}
                    onChange={(event) =>
                      void answer(item.id, event.target.value)
                    }
                  />
                ) : (
                  <select
                    className="select"
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
                  </select>
                )}
              </Field>
              <Button
                onClick={() =>
                  setIssueItem(issueItem === item.id ? undefined : item.id)
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
          Complete and queue audit
        </Button>
      )}
      <OfflineIssueList workspace={workspace} auditId={audit.id} />
    </PageSection>
  );
}

function useOfflineAnswers(audit: OfflineAudit, key: string) {
  const [responses, setResponses] = useState(audit.responses);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string>();
  const [sealing, setSealing] = useState(false);
  useUnsavedChanges(
    pending > 0 || Boolean(error),
    "Some audit answers have not been saved on this device.",
  );
  async function answer(itemId: string, value: string) {
    setResponses((current) => ({ ...current, [itemId]: value }));
    setPending((count) => count + 1);
    try {
      await saveOfflineAnswer(key, audit.id, itemId, value);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Answer not saved. Check device storage and retry.",
      );
    } finally {
      setPending((count) => count - 1);
    }
  }
  async function save(complete: boolean) {
    setSealing(true);
    setPending((count) => count + 1);
    try {
      // Retry any previously failed local saves before sealing the snapshot.
      for (const [id, value] of Object.entries(responses))
        await saveOfflineAnswer(key, audit.id, id, value);
      if (complete) await queueOfflineAudit(key, audit.id);
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not queue audit.",
      );
    } finally {
      setSealing(false);
      setPending((count) => count - 1);
    }
  }
  return { responses, pending, sealing, error, answer, save };
}
