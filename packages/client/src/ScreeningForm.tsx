import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  Field,
  LoadingState,
  Toast,
} from "@balebase/ui/react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  type CheckrTestCandidate,
  downloadScreeningConsent,
  getScreeningForm,
  type ScreeningForm as ScreeningFormData,
  submitScreening,
} from "./employeeFormsApi";
import { organizationPeoplePath } from "./organizationState";
import { handleNavigation } from "./workspacePaths";

const usStates =
  "AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split(
    " ",
  );

type Step = "details" | "disclosure" | "notices" | "rights" | "sign";

const stepLabels: Record<Step, string> = {
  details: "Your details",
  disclosure: "Disclosure",
  notices: "State notices",
  rights: "Your rights",
  sign: "Sign",
};

interface Details {
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

interface Answers {
  authorize: boolean;
  copyRequested: boolean;
  details: Details;
  disclosure: boolean;
  electronicRecords: boolean;
  notices: string[];
  signatureName: string;
  summaryOfRights: boolean;
}

type UpdateAnswers = (change: Partial<Answers>) => void;

/**
 * The person's background check: the disclosures to read, their details, any
 * state notices, and the signed authorization, one step at a time. Balebase
 * orders the Checkr report only after they sign.
 */
export function ScreeningForm({
  memberId,
  onNavigate,
  requirementId,
}: {
  memberId: string;
  onNavigate: (pathname: string) => void;
  requirementId: string;
}) {
  const [form, setForm] = useState<ScreeningFormData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    getScreeningForm(requirementId).then(
      (loaded) => current && setForm(loaded),
      (cause: unknown) =>
        current &&
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load the background check.",
        ),
    );
    return () => {
      current = false;
    };
  }, [requirementId]);
  const back = organizationPeoplePath(memberId);
  if (error) {
    return (
      <Banner
        actions={
          <ButtonLink
            href={back}
            onClick={(event) => handleNavigation(event, back, onNavigate)}
            size="sm"
          >
            Back to your page
          </ButtonLink>
        }
        tone="danger"
      >
        {error}
      </Banner>
    );
  }
  if (!form) return <LoadingState label="Loading background check…" />;
  return (
    <ScreeningSteps
      back={back}
      form={form}
      onNavigate={onNavigate}
      requirementId={requirementId}
    />
  );
}

function ScreeningSteps({
  back,
  form,
  onNavigate,
  requirementId,
}: {
  back: string;
  form: ScreeningFormData;
  onNavigate: (pathname: string) => void;
  requirementId: string;
}) {
  const [answers, setAnswers] = useState(() => initialAnswers(form));
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const update: UpdateAnswers = (change) =>
    setAnswers((current) => ({ ...current, ...change }));
  const notices = requiredNotices(form, answers.details.residenceState);
  const steps: Step[] = [
    "rights",
    "disclosure",
    "details",
    ...(notices.length ? (["notices"] as const) : []),
    "sign",
  ];
  const step = steps[Math.min(stepIndex, steps.length - 1)] ?? "rights";
  const move = (offset: number) => {
    setError(undefined);
    setStepIndex((index) => index + offset);
  };
  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await submitScreening(requirementId, submission(answers, notices));
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit.");
    } finally {
      setBusy(false);
    }
  }
  if (submitted) {
    return (
      <div className="screeningForm">
        <Submitted
          back={back}
          form={form}
          onNavigate={onNavigate}
          requirementId={requirementId}
        />
      </div>
    );
  }
  return (
    <div className="screeningForm">
      <ScreeningHeader form={form} step={step} steps={steps} />
      {error && <Toast tone="danger">{error}</Toast>}
      <StepContent
        answers={answers}
        back={back}
        busy={busy}
        form={form}
        notices={notices}
        onBack={() => move(-1)}
        onNavigate={onNavigate}
        onNext={() => move(1)}
        onSubmit={() => void submit()}
        step={step}
        update={update}
      />
    </div>
  );
}

function StepContent({ step, ...props }: StepProps & { step: Step }) {
  if (step === "rights") return <RightsStep {...props} />;
  if (step === "disclosure") return <DisclosureStep {...props} />;
  if (step === "details") return <DetailsStep {...props} />;
  if (step === "notices") return <NoticesStep {...props} />;
  return <SignStep {...props} />;
}

interface StepProps {
  answers: Answers;
  back: string;
  busy: boolean;
  form: ScreeningFormData;
  notices: string[];
  onBack: () => void;
  onNavigate: (pathname: string) => void;
  onNext: () => void;
  onSubmit: () => void;
  update: UpdateAnswers;
}

function ScreeningHeader({
  form,
  step,
  steps,
}: {
  form: ScreeningFormData;
  step: Step;
  steps: Step[];
}) {
  const location = [form.workLocation.city, form.workLocation.state]
    .filter(Boolean)
    .join(", ");
  return (
    <header className="screeningHeader">
      <div className="screeningHeading">
        <h2 className="sectionTitle">{form.title}</h2>
        {form.testCandidates && (
          <Badge tone="warning">Test mode · Checkr staging</Badge>
        )}
      </div>
      <p className="sectionDescription">
        {form.organizationName} requested a background check through Checkr for
        work in {location}. Balebase sends your details to Checkr only after you
        sign.
      </p>
      <ol aria-label="Steps" className="screeningSteps">
        {steps.map((item, index) => (
          <li aria-current={item === step ? "step" : undefined} key={item}>
            <span className="screeningStepNumber">{index + 1}</span>
            {stepLabels[item]}
          </li>
        ))}
      </ol>
    </header>
  );
}

function StepCard({
  children,
  continueDisabled = false,
  continueLabel = "Continue",
  footerStart,
  onBack,
  onContinue,
  busy = false,
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  continueDisabled?: boolean;
  continueLabel?: string;
  footerStart?: ReactNode;
  onBack: (() => void) | ReactNode;
  onContinue: () => void;
  title: string;
}) {
  return (
    <Card
      footer={
        <>
          {typeof onBack === "function" ? (
            <Button onClick={onBack} variant="ghost">
              Back
            </Button>
          ) : (
            onBack
          )}
          <div className="screeningFooterEnd">
            {footerStart}
            <Button
              busy={busy}
              disabled={continueDisabled || busy}
              type="submit"
              variant="primary"
            >
              {continueLabel}
            </Button>
          </div>
        </>
      }
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onContinue();
      }}
      title={title}
    >
      {children}
    </Card>
  );
}

function Paragraphs({ paragraphs }: { paragraphs: string[] }) {
  return (
    <div className="screeningText">
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  );
}

function Acknowledge({
  checked,
  children,
  onChange,
}: {
  checked: boolean;
  children: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{children}</span>
    </label>
  );
}

function RightsStep({
  answers,
  back,
  form,
  onNavigate,
  onNext,
  update,
}: StepProps) {
  const { summaryOfRights } = form.disclosures;
  return (
    <StepCard
      continueDisabled={!answers.summaryOfRights}
      onBack={
        <ButtonLink
          href={back}
          onClick={(event) => handleNavigation(event, back, onNavigate)}
          variant="ghost"
        >
          Cancel
        </ButtonLink>
      }
      onContinue={onNext}
      title={summaryOfRights.title}
    >
      <Paragraphs paragraphs={summaryOfRights.paragraphs} />
      <ButtonLink
        className="screeningLink"
        href={form.summaryOfRightsUrl}
        iconEnd="external"
        rel="noreferrer"
        target="_blank"
      >
        Open the summary of your rights (PDF)
      </ButtonLink>
      <Acknowledge
        checked={answers.summaryOfRights}
        onChange={(summaryOfRights) => update({ summaryOfRights })}
      >
        I received and read A Summary of Your Rights Under the Fair Credit
        Reporting Act.
      </Acknowledge>
    </StepCard>
  );
}

/** The disclosure stands alone on its step, as the law requires. */
function DisclosureStep({ answers, form, onBack, onNext, update }: StepProps) {
  const { disclosure } = form.disclosures;
  return (
    <StepCard
      continueDisabled={!answers.disclosure}
      onBack={onBack}
      onContinue={onNext}
      title={disclosure.title}
    >
      <Paragraphs paragraphs={disclosure.paragraphs} />
      <Acknowledge
        checked={answers.disclosure}
        onChange={(value) => update({ disclosure: value })}
      >
        I read this disclosure.
      </Acknowledge>
    </StepCard>
  );
}

function DetailsStep({ answers, form, onBack, onNext, update }: StepProps) {
  const details = answers.details;
  const set = (change: Partial<Details>) =>
    update({ details: { ...details, ...change } });
  return (
    <>
      {form.testCandidates && (
        <TestCandidates
          candidates={form.testCandidates}
          onFill={(candidate) =>
            update({
              details: filledDetails(candidate),
              signatureName: [
                candidate.firstName,
                candidate.middleName,
                candidate.lastName,
              ]
                .filter(Boolean)
                .join(" "),
            })
          }
        />
      )}
      <StepCard onBack={onBack} onContinue={onNext} title="Your details">
        <p className="textSm textSubtle">
          Enter your legal name and details as they appear on your government
          records. Checkr contacts you at {form.candidate.email}. Balebase
          passes your Social Security number, birth date, and license number to
          Checkr without keeping them.
        </p>
        <NameFields details={details} set={set} />
        <IdentityFields details={details} set={set} />
        <LicenseFields
          details={details}
          required={form.requiresDriverLicense}
          set={set}
        />
      </StepCard>
    </>
  );
}

interface FieldsProps {
  details: Details;
  set: (change: Partial<Details>) => void;
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
      <Acknowledge
        checked={details.noMiddleName}
        onChange={(noMiddleName) => set({ noMiddleName })}
      >
        I don’t have a middle name.
      </Acknowledge>
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
function TestCandidates({
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

function NoticesStep({
  answers,
  form,
  notices,
  onBack,
  onNext,
  update,
}: StepProps) {
  const offersCopy = notices.some(
    (state) => form.disclosures.stateNotices[state]?.offersCopy,
  );
  return (
    <StepCard
      continueDisabled={
        !notices.every((state) => answers.notices.includes(state))
      }
      onBack={onBack}
      onContinue={onNext}
      title="State notices"
    >
      {notices.map((state) => {
        const notice = form.disclosures.stateNotices[state];
        if (!notice) return null;
        return (
          <section className="screeningNotice" key={state}>
            <h3 className="screeningNoticeTitle">{notice.title}</h3>
            <Paragraphs paragraphs={notice.paragraphs} />
            <Acknowledge
              checked={answers.notices.includes(state)}
              onChange={(checked) =>
                update({
                  notices: checked
                    ? [...answers.notices, state]
                    : answers.notices.filter((item) => item !== state),
                })
              }
            >
              I received the {notice.title}.
            </Acknowledge>
          </section>
        );
      })}
      {offersCopy && (
        <Acknowledge
          checked={answers.copyRequested}
          onChange={(copyRequested) => update({ copyRequested })}
        >
          Send me a free copy of the report.
        </Acknowledge>
      )}
    </StepCard>
  );
}

function SignStep({
  answers,
  busy,
  form,
  onBack,
  onSubmit,
  update,
}: StepProps) {
  const { authorization, electronicRecords } = form.disclosures;
  return (
    <StepCard
      busy={busy}
      continueDisabled={
        !answers.electronicRecords ||
        !answers.authorize ||
        !answers.signatureName.trim()
      }
      continueLabel="Sign and submit"
      onBack={onBack}
      onContinue={onSubmit}
      title={authorization.title}
    >
      <section className="screeningNotice">
        <h3 className="screeningNoticeTitle">{electronicRecords.title}</h3>
        <Paragraphs paragraphs={electronicRecords.paragraphs} />
        <Acknowledge
          checked={answers.electronicRecords}
          onChange={(value) => update({ electronicRecords: value })}
        >
          I agree to use electronic records and to sign electronically.
        </Acknowledge>
      </section>
      <Paragraphs paragraphs={authorization.paragraphs} />
      <Field
        hint="Your typed name is your electronic signature."
        label="Type your full legal name"
      >
        <input
          autoComplete="name"
          className="input screeningSignature"
          maxLength={200}
          onChange={(event) => update({ signatureName: event.target.value })}
          required
          value={answers.signatureName}
        />
      </Field>
      <Acknowledge
        checked={answers.authorize}
        onChange={(authorize) => update({ authorize })}
      >
        I authorize this background check.
      </Acknowledge>
    </StepCard>
  );
}

function Submitted({
  back,
  form,
  onNavigate,
  requirementId,
}: {
  back: string;
  form: ScreeningFormData;
  onNavigate: (pathname: string) => void;
  requirementId: string;
}) {
  const [error, setError] = useState<string>();
  return (
    <Card
      footer={
        <>
          <Button
            onClick={() =>
              void downloadScreeningConsent(requirementId).catch(
                (cause: unknown) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not download the authorization.",
                  ),
              )
            }
            variant="ghost"
          >
            Download your signed authorization
          </Button>
          <ButtonLink
            href={back}
            onClick={(event) => handleNavigation(event, back, onNavigate)}
            variant="primary"
          >
            Back to your page
          </ButtonLink>
        </>
      }
      title="Background check submitted"
    >
      {error && <Toast tone="danger">{error}</Toast>}
      <p>
        Checkr is preparing your report. {form.organizationName} sees the result
        when it’s ready, and Checkr contacts you if it needs anything else.
      </p>
    </Card>
  );
}

function initialAnswers(form: ScreeningFormData): Answers {
  return {
    authorize: false,
    copyRequested: false,
    details: {
      dob: "",
      driverLicenseNumber: "",
      driverLicenseState: "",
      firstName: "",
      lastName: "",
      middleName: "",
      noMiddleName: false,
      phone: "",
      residenceState: form.workLocation.state,
      ssn: "",
      zipcode: "",
    },
    disclosure: false,
    electronicRecords: false,
    notices: [],
    signatureName: "",
    summaryOfRights: false,
  };
}

/** States with a notice, for the work location and where the person lives. */
function requiredNotices(
  form: Pick<ScreeningFormData, "disclosures" | "workLocation">,
  residenceState: string,
) {
  return [...new Set([form.workLocation.state, residenceState])]
    .filter((state) => state && state in form.disclosures.stateNotices)
    .sort();
}

function filledDetails(candidate: CheckrTestCandidate): Details {
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

function submission(answers: Answers, notices: string[]) {
  const { residenceState, ...candidate } = answers.details;
  return {
    acknowledgments: {
      disclosure: answers.disclosure,
      stateNotices: notices.filter((state) => answers.notices.includes(state)),
      summaryOfRights: answers.summaryOfRights,
    },
    candidate,
    copyRequested: answers.copyRequested,
    residenceState,
    signature: {
      authorize: answers.authorize,
      electronicRecords: answers.electronicRecords,
      name: answers.signatureName,
    },
  };
}
