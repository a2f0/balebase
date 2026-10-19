import { Badge, Button, Card, Field } from "@balebase/ui/react";
import type { CheckrTestCandidate } from "./employeeFormsApi";

const usStates =
  "AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split(
    " ",
  );

export interface PersonDetails {
  dob: string;
  driverLicenseNumber: string;
  driverLicenseState: string;
  firstName: string;
  lastName: string;
  middleName: string;
  noMiddleName: boolean;
  phone: string;
  residenceState: string;
  ssn: string;
  zipcode: string;
}

export function emptyDetails(residenceState: string): PersonDetails {
  return {
    dob: "",
    driverLicenseNumber: "",
    driverLicenseState: "",
    firstName: "",
    lastName: "",
    middleName: "",
    noMiddleName: false,
    phone: "",
    residenceState,
    ssn: "",
    zipcode: "",
  };
}

/** The person's legal name and identifying details for Checkr. */
export function DetailFields({
  details,
  requiresDriverLicense,
  set,
}: FieldsProps & { requiresDriverLicense: boolean }) {
  return (
    <>
      <NameFields details={details} set={set} />
      <IdentityFields details={details} set={set} />
      <LicenseFields
        details={details}
        required={requiresDriverLicense}
        set={set}
      />
    </>
  );
}

interface FieldsProps {
  details: PersonDetails;
  set: (change: Partial<PersonDetails>) => void;
}

function NameFields({ details, set }: FieldsProps) {
  return (
    <div className="formGrid">
      <div className="formRow">
        <Field label="Legal first name">
          <input
            autoComplete="given-name"
            className="input"
            maxLength={50}
            onChange={(event) => set({ firstName: event.target.value })}
            required
            value={details.firstName}
          />
        </Field>
        <Field label="Middle name">
          <input
            autoComplete="additional-name"
            className="input"
            disabled={details.noMiddleName}
            maxLength={50}
            onChange={(event) => set({ middleName: event.target.value })}
            required={!details.noMiddleName}
            value={details.noMiddleName ? "" : details.middleName}
          />
        </Field>
        <Field label="Legal last name">
          <input
            autoComplete="family-name"
            className="input"
            maxLength={50}
            minLength={2}
            onChange={(event) => set({ lastName: event.target.value })}
            required
            value={details.lastName}
          />
        </Field>
      </div>
      <label className="check">
        <input
          checked={details.noMiddleName}
          onChange={(event) => set({ noMiddleName: event.target.checked })}
          type="checkbox"
        />
        <span>I don’t have a middle name.</span>
      </label>
    </div>
  );
}

function IdentityFields({ details, set }: FieldsProps) {
  return (
    <div className="formRow">
      <Field label="Date of birth">
        <input
          autoComplete="bday"
          className="input"
          onChange={(event) => set({ dob: event.target.value })}
          required
          type="date"
          value={details.dob}
        />
      </Field>
      <Field label="Social Security number">
        <input
          autoComplete="off"
          className="input"
          inputMode="numeric"
          onChange={(event) => set({ ssn: event.target.value })}
          pattern="\d{3}-?\d{2}-?\d{4}"
          placeholder="123-45-6789"
          required
          value={details.ssn}
        />
      </Field>
      <Field label="ZIP code">
        <input
          autoComplete="postal-code"
          className="input"
          inputMode="numeric"
          onChange={(event) => set({ zipcode: event.target.value })}
          pattern="\d{5}"
          required
          value={details.zipcode}
        />
      </Field>
      <Field label="State you live in">
        <StateSelect
          onChange={(residenceState) => set({ residenceState })}
          required
          value={details.residenceState}
        />
      </Field>
      <Field label="Phone" optional>
        <input
          autoComplete="tel"
          className="input"
          inputMode="tel"
          onChange={(event) => set({ phone: event.target.value })}
          type="tel"
          value={details.phone}
        />
      </Field>
    </div>
  );
}

function LicenseFields({
  details,
  required,
  set,
}: FieldsProps & { required: boolean }) {
  const either = Boolean(
    details.driverLicenseNumber || details.driverLicenseState,
  );
  return (
    <div className="formRow">
      <Field
        hint={required ? "Needed for a driving record search." : undefined}
        label="Driver’s license number"
        optional={!required}
      >
        <input
          autoComplete="off"
          className="input"
          maxLength={30}
          onChange={(event) => set({ driverLicenseNumber: event.target.value })}
          required={required || either}
          value={details.driverLicenseNumber}
        />
      </Field>
      <Field label="License state" optional={!required}>
        <StateSelect
          onChange={(driverLicenseState) => set({ driverLicenseState })}
          required={required || either}
          value={details.driverLicenseState}
        />
      </Field>
    </div>
  );
}

function StateSelect({
  onChange,
  required,
  value,
}: {
  onChange: (state: string) => void;
  required: boolean;
  value: string;
}) {
  return (
    <select
      className="select"
      onChange={(event) => onChange(event.target.value)}
      required={required}
      value={value}
    >
      <option value="">Choose a state</option>
      {usStates.map((state) => (
        <option key={state} value={state}>
          {state}
        </option>
      ))}
    </select>
  );
}

/**
 * Staging only: Checkr's mocked candidates, which complete with a known
 * result, like Stripe's test cards. Filling one enters its details exactly
 * and varies only the phone number.
 */
export function TestCandidates({
  candidates,
  onFill,
}: {
  candidates: CheckrTestCandidate[];
  onFill: (candidate: CheckrTestCandidate) => void;
}) {
  return (
    <Card
      className="screeningTestCandidates"
      description="Checkr staging completes a report only for these mocked people, entered exactly. Fill one in to get its result; each fill uses a new test phone number."
      flush
      title="Test candidates"
    >
      <ul className="rowList">
        {candidates.map((candidate) => (
          <li className="row" key={candidate.id}>
            <div className="rowMain">
              <span className="rowTitle">
                {[candidate.firstName, candidate.middleName, candidate.lastName]
                  .filter(Boolean)
                  .join(" ")}
              </span>
              <span className="rowMeta">
                {candidate.location}
                {candidate.findings.length
                  ? ` · ${candidate.findings.join("; ")}`
                  : ""}
              </span>
            </div>
            <div className="rowActions">
              <Badge
                tone={
                  candidate.expectedResult === "clear" ? "success" : "warning"
                }
              >
                {candidate.expectedResult === "clear" ? "Clear" : "Consider"}
              </Badge>
              <Button onClick={() => onFill(candidate)} size="sm">
                Fill
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function filledDetails(candidate: CheckrTestCandidate): PersonDetails {
  return {
    dob: candidate.dob,
    driverLicenseNumber: candidate.driverLicenseNumber,
    driverLicenseState: candidate.driverLicenseState,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    middleName: candidate.middleName ?? "",
    noMiddleName: !candidate.middleName,
    // 555-0100 through 555-0199 are reserved for fiction, so never reach anyone.
    phone: `202555${String(100 + Math.floor(Math.random() * 100)).padStart(4, "0")}`,
    residenceState: candidate.state,
    ssn: candidate.ssn,
    zipcode: candidate.zipcode,
  };
}
