import { Button, promptDialog, Toast } from "@balebase/ui/react";
import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import type { ContractTemplate } from "@balebase/validators/contractTemplates";
import { contractLimits } from "@balebase/validators/rules";
import { api } from "../shared/apiClient";
import { useUnsavedChanges } from "../workspace/unsavedChanges";
import { contractTemplatePath } from "../workspace/workspacePaths";
import { writtenTemplateInput } from "./contractTemplateAuthoring";
import { useTemplateRequest } from "./contractTemplateState";

/** Conversion never navigates away or changes the source contract's dirty state. */
export function SaveWrittenTemplate({
  draft,
  disabled = false,
}: {
  draft: ContractAuthoringInput;
  disabled?: boolean;
}) {
  const creator = useTemplateRequest<ContractTemplate>();
  useUnsavedChanges(creator.busy);
  async function save() {
    const name = await promptDialog({
      title: "Save as template",
      label: "Template name",
      defaultValue: draft.title,
      required: true,
      maxLength: contractLimits.title,
      confirmLabel: "Create template",
      message:
        "Copies the current text, literal merge defaults, message and role keys. Recipient names, emails and due date are not copied. Check text and defaults for private information before publishing. Your contract edits stay here.",
    });
    if (!name?.trim()) return;
    creator.start(async () => {
      const template = await api.contractTemplates.createAuthored(
        writtenTemplateInput(draft, name),
      );
      if (!template) throw new Error("Contract template not found.");
      return template;
    });
  }
  return (
    <div className="stack stackSm">
      <Button
        disabled={disabled || creator.busy}
        busy={creator.busy}
        onClick={() => void save()}
      >
        Save as template
      </Button>
      {creator.error && <Toast tone="danger">{creator.error}</Toast>}
      {creator.state.status === "succeeded" && (
        <Toast tone="success">
          Draft template created. Your contract is unchanged.{" "}
          <a
            href={contractTemplatePath(creator.state.result.id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open template in a new tab
          </a>
        </Toast>
      )}
    </div>
  );
}
