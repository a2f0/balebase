import { Badge, Button, confirmDialog, Toast } from "@balebase/ui/react";
import type {
  FormTemplate,
  TemplatePublication,
} from "@balebase/validators/forms";
import { discardedTemplateRetentionDays } from "@balebase/validators/rules";
import type { ReactNode } from "react";
import { balebase } from "../balebase";
import { formatLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { templateStatusTone } from "./TemplateCollections";

type SavePublication = (
  status: NonNullable<TemplatePublication>,
) => Promise<void>;

/**
 * A template's status, and a button that publishes or unpublishes it when
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
 * Root admins publish and unpublish global templates, and discard drafts and
 * unpublished templates, which organizations no longer see. Discarded templates can
 * be restored from Global templates until the purge job deletes them.
 */
export function GlobalFormControls({
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
  template: FormTemplate;
}) {
  const {
    busy: discarding,
    error,
    run,
  } = useAction("Could not discard the template.");
  const draft = status === "draft";
  async function discard() {
    if (
      !(await confirmDialog({
        confirmLabel: draft ? "Discard draft" : "Discard template",
        message: `This ${draft ? "draft" : "unpublished template"} will be removed from Global templates. You can restore it from Discarded templates for ${discardedTemplateRetentionDays} days; after that it is permanently deleted. Unsaved changes will be lost.`,
        title: `Discard “${template.name}”?`,
        tone: "danger",
      }))
    )
      return;
    await run(async () => {
      await balebase().api.adminFormTemplates.discard(template);
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
          {draft ? "Discard draft" : "Discard template"}
        </Button>
      )}
    </PublicationControls>
  );
}
