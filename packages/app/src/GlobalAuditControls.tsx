import { Badge, Button, confirmDialog, Toast } from "@balebase/ui/react";
import type { AuditTemplate } from "@balebase/validators/audits";
import { useState } from "react";
import { api } from "./apiClient";
import { errorMessage } from "./errors";
import { formatLabel } from "./labels";

/** Publication changes save the editor's content, including unsaved edits. */
export function GlobalAuditControls({
  busy,
  onDiscarded,
  onSave,
  status,
  template,
}: {
  busy: boolean;
  onDiscarded: () => void;
  onSave: (status: "published" | "unpublished") => Promise<void>;
  status: string;
  template: AuditTemplate;
}) {
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string>();
  async function discard() {
    if (
      !(await confirmDialog({
        confirmLabel: "Discard draft",
        message:
          "This draft will be removed from Global Audits. Unsaved changes will be lost.",
        title: `Discard “${template.name}”?`,
        tone: "danger",
      }))
    )
      return;
    setDiscarding(true);
    setError(undefined);
    try {
      await api.adminAuditTemplates.discard(template);
      onDiscarded();
    } catch (cause) {
      setError(errorMessage(cause, "Could not discard draft."));
    } finally {
      setDiscarding(false);
    }
  }
  return (
    <>
      <Badge dot tone={status === "published" ? "success" : "neutral"}>
        {formatLabel(status)}
      </Badge>
      {error && <Toast tone="danger">{error}</Toast>}
      <Button
        disabled={busy || discarding}
        onClick={() =>
          void onSave(status === "published" ? "unpublished" : "published")
        }
      >
        {status === "published" ? "Unpublish" : "Publish"}
      </Button>
      {status === "draft" && (
        <Button
          busy={discarding}
          disabled={busy}
          onClick={() => void discard()}
          variant="danger"
        >
          Discard draft
        </Button>
      )}
    </>
  );
}
