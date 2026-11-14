import { Button, Card, Field, Toast } from "@balebase/ui/react";
import type { ContractTemplate } from "@balebase/validators/contractTemplates";
import { contractLimits } from "@balebase/validators/rules";
import { useEffect, useState } from "react";
import { api } from "../shared/apiClient";
import { boxStyle, ContractPages } from "./ContractDocument";
import { fieldTypeLabel, localDate, recipientTone } from "./contractFields";
import { templateValueKeys } from "./contractTemplateAuthoring";
import { useTemplateRequest } from "./contractTemplateState";

export function ContractTemplateMapping({
  template,
  onCreated,
  onCancel,
  onBusyChange,
}: {
  template: ContractTemplate;
  onCreated: (id: string) => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const mapping = useRoleMapping(template, onCreated, onBusyChange);
  return (
    <div className="contractEditor">
      <aside className="contractEditorPanel">
        {mapping.error && <Toast tone="danger">{mapping.error}</Toast>}
        <Card title={`Use version ${template.version}`}>
          <MappingForm
            mapping={mapping}
            onCancel={onCancel}
            template={template}
          />
        </Card>
      </aside>
      <div className="contractEditorDocument">
        <ContractPages
          load={() =>
            api.contractTemplates.loadDocument(template.id, template.version)
          }
          renderOverlay={(page) =>
            template.definition.fields
              .filter((field) => field.page === page.number)
              .map((field) => {
                const roleIndex = template.definition.roles.findIndex(
                  (role) => role.key === field.roleKey,
                );
                return (
                  <span
                    className={`contractField contractFieldStatic ${recipientTone(roleIndex)}`}
                    key={fieldKey(field)}
                    style={boxStyle(field)}
                  >
                    <span className="contractFieldLabel">
                      {fieldTypeLabel(field.type)} ·{" "}
                      {template.definition.roles[roleIndex]?.label}
                    </span>
                  </span>
                );
              })
          }
        />
      </div>
    </div>
  );
}

type Mapping = ReturnType<typeof useRoleMapping>;
function useRoleMapping(
  template: ContractTemplate,
  onCreated: (id: string) => void,
  onBusyChange: (busy: boolean) => void,
) {
  const [title, setTitle] = useState(template.name);
  const [dueDate, setDueDate] = useState("");
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      templateValueKeys(template).map((key) => [
        key,
        template.authoring?.values[key] ?? "",
      ]),
    ),
  );
  const [recipients, setRecipients] = useState(() =>
    template.definition.roles.map((role) => ({
      email: "",
      name: "",
      roleKey: role.key,
    })),
  );
  const creator = useTemplateRequest<string>(onCreated);
  const busy = creator.busy || creator.state.status === "succeeded";
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  function create() {
    if (
      busy ||
      template.status !== "published" ||
      template.currentStatus !== "published"
    )
      return;
    creator.start(() =>
      api.contractTemplates.createContract(template.id, {
        dueDate: dueDate || null,
        recipients,
        title,
        version: template.version,
        ...(template.authoring ? { values } : {}),
      }),
    );
  }
  return {
    busy,
    values,
    setValues,
    create,
    dueDate,
    error: creator.error,
    recipients,
    setDueDate,
    setRecipients,
    setTitle,
    title,
  };
}

function MappingForm({
  mapping,
  onCancel,
  template,
}: {
  mapping: Mapping;
  onCancel: () => void;
  template: ContractTemplate;
}) {
  const { busy, create, dueDate, setDueDate, setTitle, title } = mapping;
  return (
    <form
      className="stack stackMd"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <p className="contractHint">
        Map each role to a person. Their fields are already placed. You can
        review the draft before sending.
      </p>
      <Field label="Contract title">
        <input
          className="input"
          disabled={busy}
          maxLength={contractLimits.title}
          onChange={(event) => setTitle(event.target.value)}
          required
          value={title}
        />
      </Field>
      <Field label="Due date" optional>
        <input
          className="input"
          disabled={busy}
          min={localDate()}
          onChange={(event) => setDueDate(event.target.value)}
          type="date"
          value={dueDate}
        />
      </Field>
      {template.definition.roles.map((role) => (
        <MappingRole mapping={mapping} key={role.key} role={role} />
      ))}
      {Object.entries(mapping.values).map(([key, value]) => (
        <Field
          key={key}
          label={key}
          hint="Used only in this contract; the template default stays unchanged."
        >
          <textarea
            className="textarea"
            disabled={busy}
            maxLength={2000}
            value={value}
            onChange={(event) =>
              mapping.setValues((current) => ({
                ...current,
                [key]: event.target.value,
              }))
            }
          />
        </Field>
      ))}
      <Button
        busy={busy}
        disabled={
          template.status !== "published" ||
          template.currentStatus !== "published"
        }
        type="submit"
        variant="primary"
      >
        Create contract
      </Button>
      <Button disabled={busy} onClick={onCancel} type="button" variant="ghost">
        Back to template
      </Button>
    </form>
  );
}

const fieldKeys = new WeakMap<object, string>();
function fieldKey(field: object) {
  let key = fieldKeys.get(field);
  if (!key) {
    key = crypto.randomUUID();
    fieldKeys.set(field, key);
  }
  return key;
}

function MappingRole({
  mapping,
  role,
}: {
  mapping: Mapping;
  role: ContractTemplate["definition"]["roles"][number];
}) {
  const { busy, recipients, setRecipients } = mapping;
  const recipient = recipients.find((person) => person.roleKey === role.key);
  const change = (property: "name" | "email", value: string) =>
    setRecipients((current) =>
      current.map((person) =>
        person.roleKey === role.key ? { ...person, [property]: value } : person,
      ),
    );
  return (
    <fieldset
      className="stack stackSm contractTemplateRole"
      disabled={busy}
      key={role.key}
    >
      <legend>{role.label}</legend>
      <Field label={`${role.label} name`}>
        <input
          autoComplete="name"
          className="input"
          maxLength={contractLimits.signerName}
          onChange={(event) => change("name", event.target.value)}
          required
          value={recipient?.name ?? ""}
        />
      </Field>
      <Field label={`${role.label} email`}>
        <input
          autoComplete="email"
          className="input"
          maxLength={contractLimits.signerEmail}
          onChange={(event) => change("email", event.target.value)}
          required
          type="email"
          value={recipient?.email ?? ""}
        />
      </Field>
    </fieldset>
  );
}
