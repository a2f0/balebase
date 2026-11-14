import { Button, Card, Field, Select } from "@balebase/ui/react";
import type { ContractAuthoringInput } from "@balebase/validators/contractAuthoring";
import { contractLimits } from "@balebase/validators/rules";
import { useState } from "react";
import { localDate, reminderOptions } from "./contractFields";

type DetailsProps = {
  draft: ContractAuthoringInput;
  onChange: (draft: ContractAuthoringInput) => void;
};

export function ContractAuthoringDetails({ draft, onChange }: DetailsProps) {
  const set = <Key extends keyof ContractAuthoringInput>(
    key: Key,
    value: ContractAuthoringInput[Key],
  ) => onChange({ ...draft, [key]: value });
  return (
    <div className="stack stackMd">
      <Card title="Details">
        <div className="stack stackMd">
          <Field label="Title">
            <input
              className="input"
              maxLength={contractLimits.title}
              onChange={(event) => set("title", event.target.value)}
              value={draft.title}
            />
          </Field>
          <Field
            label="Message"
            hint="Included in the email to every signer."
            optional
          >
            <textarea
              className="textarea"
              maxLength={contractLimits.message}
              onChange={(event) => set("message", event.target.value)}
              rows={3}
              value={draft.message}
            />
          </Field>
          <Field label="Due date" optional>
            <input
              className="input"
              min={localDate()}
              onChange={(event) => set("dueDate", event.target.value || null)}
              type="date"
              value={draft.dueDate ?? ""}
            />
          </Field>
          <Field label="Reminders">
            <Select
              onChange={(event) =>
                set(
                  "reminderIntervalDays",
                  event.target.value ? Number(event.target.value) : null,
                )
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
      <AuthoringRecipients draft={draft} onChange={onChange} />
      <AuthoringValues draft={draft} onChange={onChange} />
    </div>
  );
}

function AuthoringRecipients({ draft, onChange }: DetailsProps) {
  // Role keys are editable document data, not React identities.
  const [rowIds, setRowIds] = useState(() =>
    draft.recipients.map(() => crypto.randomUUID()),
  );
  const update = (
    index: number,
    change: Partial<ContractAuthoringInput["recipients"][number]>,
  ) =>
    onChange({
      ...draft,
      recipients: draft.recipients.map((recipient, position) =>
        position === index ? { ...recipient, ...change } : recipient,
      ),
    });
  return (
    <Card
      title="Signer roles"
      actions={
        <Button
          disabled={draft.recipients.length >= contractLimits.signers}
          size="sm"
          onClick={() => {
            let number = draft.recipients.length + 1;
            while (
              draft.recipients.some(({ key }) => key === `signer${number}`)
            )
              number += 1;
            setRowIds((current) => [...current, crypto.randomUUID()]);
            onChange({
              ...draft,
              recipients: [
                ...draft.recipients,
                {
                  email: "",
                  key: `signer${number}`,
                  name: "",
                  routingOrder: draft.recipients.length + 1,
                },
              ],
            });
          }}
        >
          Add signer
        </Button>
      }
    >
      <div className="stack stackMd">
        <Field label="Signing order">
          <Select
            value={draft.signingOrder}
            onChange={(event) =>
              onChange({
                ...draft,
                signingOrder: event.target
                  .value as ContractAuthoringInput["signingOrder"],
              })
            }
          >
            <option value="parallel">Any order</option>
            <option value="sequential">One after another</option>
          </Select>
        </Field>
        <p className="contractHint">
          Role keys connect fields and merge values to signers. If you rename or
          remove a role, update its references in Markdown before saving.
        </p>
        {rowIds.map((rowId, index) => {
          const recipient = draft.recipients[index];
          if (!recipient) return null;
          return (
            <AuthoringRecipientRow
              key={rowId}
              index={index}
              recipient={recipient}
              sequential={draft.signingOrder === "sequential"}
              onChange={(change) => update(index, change)}
              onRemove={() => {
                setRowIds((current) =>
                  current.filter((_, position) => position !== index),
                );
                onChange({
                  ...draft,
                  recipients: draft.recipients.filter(
                    (_, position) => position !== index,
                  ),
                });
              }}
            />
          );
        })}
      </div>
    </Card>
  );
}

function AuthoringRecipientRow({
  index,
  recipient,
  sequential,
  onChange,
  onRemove,
}: {
  index: number;
  recipient: ContractAuthoringInput["recipients"][number];
  sequential: boolean;
  onChange: (
    change: Partial<ContractAuthoringInput["recipients"][number]>,
  ) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset className="contractAuthoringRole stack stackSm">
      <legend>Signer {index + 1}</legend>
      <Field label="Role key">
        <input
          className="input"
          maxLength={100}
          onChange={(event) => onChange({ key: event.target.value })}
          value={recipient.key}
        />
      </Field>
      <Field label="Full name">
        <input
          className="input"
          maxLength={contractLimits.signerName}
          onChange={(event) => onChange({ name: event.target.value })}
          value={recipient.name}
        />
      </Field>
      <Field label="Email">
        <input
          className="input"
          type="email"
          maxLength={contractLimits.signerEmail}
          onChange={(event) => onChange({ email: event.target.value })}
          value={recipient.email}
        />
      </Field>
      {sequential && (
        <Field label="Signs in position">
          <input
            className="input"
            type="number"
            min={1}
            max={contractLimits.signers}
            onChange={(event) =>
              onChange({
                routingOrder: Math.max(1, Number(event.target.value) || 1),
              })
            }
            value={recipient.routingOrder}
          />
        </Field>
      )}
      <Button size="sm" variant="ghost" onClick={onRemove}>
        Remove signer {index + 1}
      </Button>
    </fieldset>
  );
}

export function AuthoringValues({
  draft,
  onChange,
  templateDefaults = false,
}: DetailsProps & { templateDefaults?: boolean }) {
  const [key, setKey] = useState("");
  const validKey = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$/.test(
    key,
  );
  return (
    <Card title={templateDefaults ? "Merge defaults" : "Merge values"}>
      <div className="stack stackMd">
        <p className="contractHint">
          Signer role.name and role.email resolve automatically. Add other
          plain-text values here. Values are never treated as Markdown.
          {templateDefaults &&
            " Defaults are copied into new contracts and can be changed for each use. Values without defaults can be filled in when creating a contract."}
        </p>
        {Object.entries(draft.values).map(([name, value]) => (
          <div className="stack stackSm" key={name}>
            <Field label={name}>
              <textarea
                className="textarea"
                maxLength={2000}
                rows={2}
                value={value}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    values: { ...draft.values, [name]: event.target.value },
                  })
                }
              />
            </Field>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const values = Object.fromEntries(
                  Object.entries(draft.values).filter(
                    ([existing]) => existing !== name,
                  ),
                );
                onChange({ ...draft, values });
              }}
            >
              Remove {name}
            </Button>
          </div>
        ))}
        <Field label="New value key">
          <input
            className="input"
            maxLength={100}
            placeholder="project.title"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <Button
          disabled={
            !validKey ||
            Object.hasOwn(draft.values, key) ||
            Object.keys(draft.values).length >= 100
          }
          onClick={() => {
            onChange({ ...draft, values: { ...draft.values, [key]: "" } });
            setKey("");
          }}
        >
          Add value
        </Button>
      </div>
    </Card>
  );
}
