import { cx, Field } from "@balebase/ui/react";
import type { Business, BusinessInput } from "@balebase/validators/businesses";
import { businessLimits } from "@balebase/validators/rules";
import type { RefObject } from "react";
import { formatDuns, formatEin } from "./businessState";

export interface BusinessFormState {
  city: string;
  duns: string;
  ein: string;
  incorporationDate: string;
  name: string;
  state: string;
  streetAddress: string;
  zip: string;
}

export function BusinessFields({
  compact = false,
  disabled,
  form,
  nameField,
  onChange,
}: {
  compact?: boolean;
  disabled: boolean;
  form: BusinessFormState;
  nameField?: RefObject<HTMLInputElement | null>;
  onChange: (form: BusinessFormState) => void;
}) {
  const set = (field: keyof BusinessFormState, value: string) => {
    onChange({ ...form, [field]: value });
  };
  const input = cx("input", compact && "inputSm");
  return (
    <div className="businessFieldsFrame">
      <div className="businessFields">
        <Field className="businessFieldWide" label="Business name">
          <input
            autoComplete="organization"
            className={input}
            disabled={disabled}
            maxLength={businessLimits.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Acme, Inc."
            ref={nameField}
            required
            type="text"
            value={form.name}
          />
        </Field>
        <Field className="businessFieldHalf" label="EIN" optional>
          <input
            className={input}
            disabled={disabled}
            inputMode="numeric"
            maxLength={10}
            onChange={(event) => set("ein", event.target.value)}
            pattern="[0-9]{2}-?[0-9]{7}"
            placeholder="12-3456789"
            type="text"
            value={form.ein}
          />
        </Field>
        <Field className="businessFieldHalf" label="DUNS number" optional>
          <input
            className={input}
            disabled={disabled}
            inputMode="numeric"
            maxLength={11}
            onChange={(event) => set("duns", event.target.value)}
            pattern="[0-9]{9}|[0-9]{2}-[0-9]{3}-[0-9]{4}"
            placeholder="12-345-6789"
            type="text"
            value={form.duns}
          />
        </Field>
        <Field
          className="businessFieldHalf"
          label="Incorporation date"
          optional
        >
          <input
            className={input}
            disabled={disabled}
            onChange={(event) => set("incorporationDate", event.target.value)}
            type="date"
            value={form.incorporationDate}
          />
        </Field>
        <BusinessAddressFields
          disabled={disabled}
          form={form}
          input={input}
          set={set}
        />
      </div>
    </div>
  );
}

function BusinessAddressFields({
  disabled,
  form,
  input,
  set,
}: {
  disabled: boolean;
  form: BusinessFormState;
  input: string;
  set: (field: keyof BusinessFormState, value: string) => void;
}) {
  return (
    <>
      <Field className="businessFieldWide" label="Street address" optional>
        <input
          autoComplete="street-address"
          className={input}
          disabled={disabled}
          maxLength={businessLimits.streetAddress}
          onChange={(event) => set("streetAddress", event.target.value)}
          placeholder="123 Main Street"
          type="text"
          value={form.streetAddress}
        />
      </Field>
      <Field className="businessFieldHalf" label="City" optional>
        <input
          autoComplete="address-level2"
          className={input}
          disabled={disabled}
          maxLength={businessLimits.city}
          onChange={(event) => set("city", event.target.value)}
          placeholder="New York"
          type="text"
          value={form.city}
        />
      </Field>
      <Field className="businessFieldQuarter" label="State" optional>
        <input
          autoCapitalize="characters"
          autoComplete="address-level1"
          className={input}
          disabled={disabled}
          maxLength={2}
          onChange={(event) => set("state", event.target.value)}
          pattern="[A-Za-z]{2}"
          placeholder="NY"
          type="text"
          value={form.state}
        />
      </Field>
      <Field className="businessFieldQuarter" label="ZIP" optional>
        <input
          autoComplete="postal-code"
          className={input}
          disabled={disabled}
          inputMode="numeric"
          maxLength={10}
          onChange={(event) => set("zip", event.target.value)}
          pattern="[0-9]{5}(-[0-9]{4})?"
          placeholder="10001"
          type="text"
          value={form.zip}
        />
      </Field>
    </>
  );
}

export function businessForm(business: Business): BusinessFormState {
  return {
    city: business.city ?? "",
    duns: business.duns ? formatDuns(business.duns) : "",
    ein: business.ein ? formatEin(business.ein) : "",
    incorporationDate: business.incorporationDate ?? "",
    name: business.name,
    state: business.state ?? "",
    streetAddress: business.streetAddress ?? "",
    zip: business.zip ?? "",
  };
}

export function emptyBusinessForm(): BusinessFormState {
  return {
    city: "",
    duns: "",
    ein: "",
    incorporationDate: "",
    name: "",
    state: "",
    streetAddress: "",
    zip: "",
  };
}

/**
 * The name, which every save sends, and the fields edited since `baseline`,
 * so a save keeps another manager's concurrent changes to other fields.
 */
export function changedBusinessInput(
  baseline: BusinessFormState,
  form: BusinessFormState,
): BusinessInput {
  const before = businessInput(baseline);
  const after = businessInput(form);
  const changed = Object.entries(after).filter(
    ([field, value]) => before[field as keyof BusinessInput] !== value,
  );
  return { ...Object.fromEntries(changed), name: after.name };
}

export function businessInput(form: BusinessFormState): BusinessInput {
  return {
    city: form.city.trim() || null,
    duns: form.duns.trim() || null,
    ein: form.ein.trim() || null,
    incorporationDate: form.incorporationDate || null,
    name: form.name.trim(),
    state: form.state.trim() || null,
    streetAddress: form.streetAddress.trim() || null,
    zip: form.zip.trim() || null,
  };
}
