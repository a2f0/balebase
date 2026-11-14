import {
  Button,
  Card,
  confirmDialog,
  Field,
  Select,
  Toast,
} from "@balebase/ui/react";
import type {
  ContractTemplate,
  TemplateDefinition,
} from "@balebase/validators/contractTemplates";
import { contractLimits } from "@balebase/validators/rules";
import { useCallback, useEffect, useState } from "react";
import { api } from "../shared/apiClient";
import { countLabel } from "../shared/labels";
import { useUnsavedChanges } from "../workspace/unsavedChanges";
import { ContractAuthoringContent } from "./ContractAuthoringContent";
import { AuthoringValues } from "./ContractAuthoringDetails";
import { ContractPages } from "./ContractDocument";
import {
  EditorOverlay,
  FieldHelp,
  FieldToolbox,
  SelectedField,
  useContractFieldEditor,
} from "./ContractFieldEditor";
import { type DraftInput, reminderOptions } from "./contractFields";
import { useTemplateRequest } from "./contractTemplateState";

export function ContractTemplateEditor({
  template,
  onSaved,
  dirty,
  onDirtyChange,
  onBusyChange,
  disabled = false,
  canPublish = false,
}: {
  template: ContractTemplate;
  onSaved: (template: ContractTemplate) => void;
  /** Owned by the page, which guards version changes with it. */
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
  canPublish?: boolean;
}) {
  const editor = useTemplateEditor(template, onSaved, {
    dirty,
    disabled,
    onBusyChange,
    onDirtyChange,
  });
  return (
    <fieldset
      className="contractTemplateControls"
      disabled={editor.busy || disabled}
    >
      <legend className="srOnly">Template editor</legend>
      <div className="contractEditor">
        {!template.authoring && <FieldHelp />}
        <aside className="contractEditorPanel">
          {editor.error && <Toast tone="danger">{editor.error}</Toast>}
          <TemplateDetails editor={editor} />
          <TemplateRoles editor={editor} />
          {!template.authoring && <FieldToolbox editor={editor} />}
          {!template.authoring && <SelectedField editor={editor} />}
          {editor.authoringDraft && (
            <AuthoringValues
              draft={editor.authoringDraft}
              templateDefaults
              onChange={(value) =>
                editor.setAuthoring({
                  formatVersion: 1,
                  source: value.source,
                  values: value.values,
                })
              }
            />
          )}
          <Button
            busy={editor.busy}
            disabled={!editor.dirty}
            onClick={() => void editor.save()}
            variant="primary"
          >
            Save version {editor.currentVersion + 1}
          </Button>
          {canPublish && (
            <Button
              onClick={() =>
                editor.save(
                  editor.currentStatus === "published"
                    ? "unpublished"
                    : "published",
                )
              }
            >
              {editor.currentStatus === "published" ? "Unpublish" : "Publish"}
            </Button>
          )}
          {editor.error && (
            <Button onClick={editor.refresh}>
              Refresh latest version information, keep my edits
            </Button>
          )}
          <p className="contractHint">
            Saving creates a new {editor.currentStatus} version. Version{" "}
            {template.version} stays unchanged. Publication changes include the
            current editor contents.
          </p>
        </aside>
        <div className="contractEditorDocument">
          {editor.authoringDraft ? (
            <Card title="Written template">
              <ContractAuthoringContent
                draft={editor.authoringDraft}
                disabled={editor.busy || disabled}
                onChange={(source) =>
                  editor.setAuthoring({
                    formatVersion: 1,
                    source,
                    values: editor.authoringDraft?.values ?? {},
                  })
                }
              />
              <p className="contractHint">
                Save a version to update its sample PDF. Unassigned roles use
                role labels; missing defaults appear as bracketed keys.
              </p>
              <ContractPages
                load={() =>
                  api.contractTemplates.loadDocument(
                    template.id,
                    template.version,
                  )
                }
              />
            </Card>
          ) : (
            <ContractPages
              load={() =>
                api.contractTemplates.loadDocument(
                  template.id,
                  template.version,
                )
              }
              renderOverlay={(page) => (
                <EditorOverlay editor={editor} page={page} />
              )}
            />
          )}
        </div>
      </div>
    </fieldset>
  );
}

type Editor = ReturnType<typeof useTemplateEditor>;

function useTemplateEditor(
  template: ContractTemplate,
  onSaved: (template: ContractTemplate) => void,
  {
    dirty,
    disabled,
    onBusyChange,
    onDirtyChange,
  }: {
    dirty: boolean;
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
    onDirtyChange: (dirty: boolean) => void;
  },
) {
  const [draft, setDraft] = useState(() => draftFrom(template));
  const [roleIds, setRoleIds] = useState(() =>
    template.definition.roles.map(() => crypto.randomUUID()),
  );
  const [description, setDescription] = useState(template.description);
  const [authoring, setAuthoringValue] = useState(template.authoring);
  const [latest, setLatest] = useState(template);
  const saver = useTemplateRequest<ContractTemplate>((saved) => {
    onDirtyChange(false);
    onSaved(saved);
  });
  const refresher = useTemplateRequest<ContractTemplate>(setLatest);
  const busy = saver.busy || refresher.busy;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  const update = useCallback(
    (change: (draft: DraftInput) => DraftInput) => {
      if (busy) return;
      setDraft(change);
      onDirtyChange(true);
    },
    [busy, onDirtyChange],
  );
  const editor = useContractFieldEditor(
    draft,
    update,
    template.document.pageCount,
  );
  useUnsavedChanges((dirty || busy) && !disabled);

  function save(status?: "published" | "unpublished") {
    if (busy) return;
    saver.start(async () => {
      return saveTemplateVersion(template, latest.currentVersion, {
        draft,
        authoring,
        description,
        status,
      });
    });
  }
  function refresh() {
    if (busy) return;
    refresher.start(() => api.contractTemplates.get(template.id));
  }
  async function removeRole(key: string) {
    const count = draft.fields.filter(
      (field) => field.recipientKey === key,
    ).length;
    if (count && !(await confirmRoleRemoval(count))) return;
    setRoleIds((current) =>
      current.filter((_, index) => draft.recipients[index]?.key !== key),
    );
    update((current) => ({
      ...current,
      recipients: current.recipients.filter((role) => role.key !== key),
      fields: current.fields.filter((field) => field.recipientKey !== key),
    }));
  }

  return {
    ...editor,
    roleIds,
    addRole: () => {
      if (busy) return;
      setRoleIds((current) => [...current, crypto.randomUUID()]);
      update(appendTemplateRole);
    },
    busy,
    authoringDraft: authoring ? { ...draft, ...authoring } : null,
    setAuthoring: (value: NonNullable<ContractTemplate["authoring"]>) => {
      if (busy) return;
      setAuthoringValue(value);
      onDirtyChange(true);
    },
    refresh,
    currentVersion: latest.currentVersion,
    currentStatus: latest.currentStatus,
    description,
    dirty,
    error: refresher.error ?? saver.error,
    removeRole,
    save,
    setDescription: (value: string) => {
      setDescription(value);
      onDirtyChange(true);
    },
  };
}

async function saveTemplateVersion(
  template: ContractTemplate,
  currentVersion: number,
  input: {
    draft: DraftInput;
    authoring: ContractTemplate["authoring"];
    description: string;
    status: "published" | "unpublished" | undefined;
  },
) {
  const { draft, authoring, description, status } = input;
  const definition = definitionFrom(draft);
  if (authoring) definition.fields = [];
  const saved = await api.contractTemplates.saveVersion(
    { ...template, currentVersion },
    {
      definition,
      description,
      name: draft.title,
      ...(authoring ? { authoring } : {}),
      ...(status ? { status } : {}),
    },
  );
  if (!saved) throw new Error("Contract template not found.");
  return saved;
}

function appendTemplateRole(current: DraftInput): DraftInput {
  return {
    ...current,
    recipients: [
      ...current.recipients,
      {
        email: "",
        key: nextRoleKey(current),
        name: `Role ${current.recipients.length + 1}`,
        routingOrder: Math.min(
          20,
          Math.max(0, ...current.recipients.map((role) => role.routingOrder)) +
            1,
        ),
      },
    ],
  };
}

function definitionFrom(draft: DraftInput): TemplateDefinition {
  return {
    fields: draft.fields.map(({ key: _key, recipientKey, ...field }) => ({
      ...field,
      roleKey: recipientKey,
    })),
    message: draft.message,
    reminderIntervalDays: draft.reminderIntervalDays,
    roles: draft.recipients.map(({ key, name, routingOrder }) => ({
      key,
      label: name,
      routingOrder,
    })),
    signingOrder: draft.signingOrder,
  };
}

function TemplateDetails({ editor }: { editor: Editor }) {
  const { draft, update, description, setDescription } = editor;
  return (
    <Card title="Template details">
      <div className="stack stackMd">
        <Field label="Template name">
          <input
            className="input"
            maxLength={contractLimits.title}
            onChange={(event) =>
              update((current) => ({
                ...current,
                title: event.target.value,
              }))
            }
            value={draft.title}
          />
        </Field>
        <Field label="Description" optional>
          <textarea
            className="textarea"
            maxLength={contractLimits.description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            rows={2}
            value={description}
          />
        </Field>
        <Field
          hint="Included in the email to every signer."
          label="Message"
          optional
        >
          <textarea
            className="textarea"
            maxLength={contractLimits.message}
            onChange={(event) =>
              update((current) => ({
                ...current,
                message: event.target.value,
              }))
            }
            rows={3}
            value={draft.message}
          />
        </Field>
        <Field label="Reminders">
          <Select
            onChange={(event) =>
              update((current) => ({
                ...current,
                reminderIntervalDays: event.target.value
                  ? Number(event.target.value)
                  : null,
              }))
            }
            value={draft.reminderIntervalDays ?? ""}
          >
            {reminderOptions.map((option) => (
              <option key={option.label} value={option.value ?? ""}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Card>
  );
}

function TemplateRoles({ editor }: { editor: Editor }) {
  const { draft, update } = editor;
  return (
    <Card
      actions={
        <Button
          disabled={draft.recipients.length >= contractLimits.signers}
          icon="add"
          onClick={editor.addRole}
          size="sm"
          variant="ghost"
        >
          Add role
        </Button>
      }
      title="Signer roles"
    >
      <div className="stack stackMd">
        <p className="contractHint">
          Use labels such as Employee or Company. People are assigned when you
          create a contract.
        </p>
        <Field label="Signing order">
          <Select
            onChange={(event) =>
              update((current) => ({
                ...current,
                signingOrder: event.target.value as DraftInput["signingOrder"],
              }))
            }
            value={draft.signingOrder}
          >
            <option value="parallel">Any order</option>
            <option value="sequential">One after another</option>
          </Select>
        </Field>
        {draft.recipients.map((role, index) => (
          <TemplateRoleRow
            editor={editor}
            index={index}
            key={editor.roleIds[index]}
            role={role}
          />
        ))}
      </div>
    </Card>
  );
}

function TemplateRoleRow({
  editor,
  index,
  role,
}: {
  editor: Editor;
  index: number;
  role: DraftInput["recipients"][number];
}) {
  const { draft, update, removeRole } = editor;
  return (
    <div className="stack stackSm">
      <Field label={`Role ${index + 1}`}>
        <input
          className="input"
          maxLength={contractLimits.signerName}
          onChange={(event) =>
            update((current) => ({
              ...current,
              recipients: current.recipients.map((item) =>
                item.key === role.key
                  ? { ...item, name: event.target.value }
                  : item,
              ),
            }))
          }
          value={role.name}
        />
      </Field>
      {editor.authoringDraft && (
        <Field
          label={`Role ${index + 1} key`}
          hint="Update matching field and value references in Markdown when changing this key."
        >
          <input
            className="input"
            maxLength={100}
            value={role.key}
            onChange={(event) =>
              update((current) => ({
                ...current,
                recipients: current.recipients.map((item, position) =>
                  position === index
                    ? { ...item, key: event.target.value }
                    : item,
                ),
              }))
            }
          />
        </Field>
      )}
      {draft.signingOrder === "sequential" && (
        <Field label={`${role.name || "Role"} signs in position`}>
          <input
            className="input inputSm"
            max={20}
            min={1}
            onChange={(event) =>
              update((current) => ({
                ...current,
                recipients: current.recipients.map((item) =>
                  item.key === role.key
                    ? {
                        ...item,
                        routingOrder: Number(event.target.value) || 1,
                      }
                    : item,
                ),
              }))
            }
            type="number"
            value={role.routingOrder}
          />
        </Field>
      )}
      <Button
        onClick={() => void removeRole(role.key)}
        size="sm"
        variant="ghost"
      >
        Remove {role.name || "role"}
      </Button>
    </div>
  );
}

function draftFrom(template: ContractTemplate): DraftInput {
  return {
    dueDate: null,
    fields: template.definition.fields.map(({ roleKey, ...field }) => ({
      ...field,
      key: crypto.randomUUID(),
      recipientKey: roleKey,
    })),
    message: template.definition.message,
    recipients: template.definition.roles.map(
      ({ key, label, routingOrder }) => ({
        email: "",
        key,
        name: label,
        routingOrder,
      }),
    ),
    reminderIntervalDays: template.definition.reminderIntervalDays,
    signingOrder: template.definition.signingOrder,
    title: template.name,
  };
}

function nextRoleKey(draft: DraftInput) {
  let number = draft.recipients.length + 1;
  while (draft.recipients.some(({ key }) => key === `signer${number}`))
    number += 1;
  return `signer${number}`;
}

function confirmRoleRemoval(fieldCount: number) {
  return confirmDialog({
    confirmLabel: "Remove role",
    message: `Its ${countLabel(fieldCount, "field")} will be removed too.`,
    title: "Remove this role?",
    tone: "danger",
  });
}
