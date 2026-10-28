import { Badge, Button, confirmDialog, Toast } from "@balebase/ui/react";
import type { AuditTemplate } from "@balebase/validators/audits";
import { api } from "./apiClient";
import { formatLabel } from "./labels";
import { useAction } from "./useAction";

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
  const {
    busy: discarding,
    error,
    run,
  } = useAction("Could not discard draft.");
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
    await run(async () => {
      await api.adminAuditTemplates.discard(template);
      onDiscarded();
    });
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
