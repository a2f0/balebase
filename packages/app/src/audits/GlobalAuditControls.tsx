import { Badge, Button, confirmDialog, Toast } from "@balebase/ui/react";
import { discardedTemplateRetentionDays } from "@balebase/validators/adminAuditTemplates";
import type {
  AuditTemplate,
  TemplatePublication,
} from "@balebase/validators/audits";
import type { ReactNode } from "react";
import { api } from "../shared/apiClient";
import { formatLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { templateStatusTone } from "./AuditHome";

type SavePublication = (
  status: NonNullable<TemplatePublication>,
) => Promise<void>;

/**
 * A form's status, and a button that publishes or unpublishes it when
 * `onSave` is given. Publication changes save the editor's content,
 * including unsaved edits.
 */
export function PublicationControls({
  busy,
  children,
  onSave,
  status,
}: {
  busy: boolean;
  children?: ReactNode;
  onSave?: SavePublication | undefined;
  status: string;
}) {
  return (
    <>
      <Badge dot tone={templateStatusTone(status)}>
        {formatLabel(status)}
      </Badge>
      {onSave && (
        <Button
          disabled={busy}
          onClick={() =>
            void onSave(status === "published" ? "unpublished" : "published")
          }
        >
          {status === "published" ? "Unpublish" : "Publish"}
        </Button>
      )}
      {children}
    </>
  );
}

/**
 * Root admins publish and unpublish global forms, and discard drafts and
 * unpublished forms, which organizations no longer see. Discarded forms can
 * be restored from Global Audits until the purge job deletes them.
 */
export function GlobalAuditControls({
  busy,
  onDiscarded,
  onSave,
  status,
  template,
}: {
  busy: boolean;
  onDiscarded: () => void;
  onSave: SavePublication;
  status: string;
  template: AuditTemplate;
}) {
  const {
    busy: discarding,
    error,
    run,
  } = useAction("Could not discard the form.");
  const draft = status === "draft";
  async function discard() {
    if (
      !(await confirmDialog({
        confirmLabel: draft ? "Discard draft" : "Discard form",
        message: `This ${draft ? "draft" : "unpublished form"} will be removed from Global Audits. You can restore it from Discarded forms for ${discardedTemplateRetentionDays} days; after that it is permanently deleted. Unsaved changes will be lost.`,
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
    <PublicationControls
      busy={busy || discarding}
      onSave={onSave}
      status={status}
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {status !== "published" && (
        <Button
          busy={discarding}
          disabled={busy}
          onClick={() => void discard()}
          variant="danger"
        >
          {draft ? "Discard draft" : "Discard form"}
        </Button>
      )}
    </PublicationControls>
  );
}
