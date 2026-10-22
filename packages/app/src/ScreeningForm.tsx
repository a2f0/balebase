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
import type { ScreeningForm as ScreeningFormData } from "@balebase/validators/employeeForms";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api } from "./apiClient";
import { downloadScreeningConsent } from "./employeeFormDownloads";
import {
  DetailFields,
  emptyDetails,
  filledDetails,
  type PersonDetails,
  TestCandidates,
} from "./ScreeningDetails";
import { handleNavigation } from "./workspacePaths";

type Step = "details" | "disclosure" | "notices" | "rights" | "sign";

const stepLabels: Record<Step, string> = {
  details: "Your details",
  disclosure: "Disclosure",
  notices: "State notices",
  rights: "Your rights",
  sign: "Sign",
};

interface Answers {
  authorize: boolean;
  copyRequested: boolean;
  details: PersonDetails;
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
  back,
  onNavigate,
  requirementId,
}: {
  /** Where the person returns to: My documents. */
  back: string;
  onNavigate: (pathname: string) => void;
  requirementId: string;
}) {
  const [form, setForm] = useState<ScreeningFormData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    api.employeeForms.screeningForm(requirementId).then(
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
  if (error) {
    return (
      <Banner
        actions={
          <ButtonLink
            href={back}
            onClick={(event) => handleNavigation(event, back, onNavigate)}
            size="sm"
          >
            Back to My documents
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
      await api.employeeForms.submitScreening(
        requirementId,
        submission(answers, notices, form),
      );
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
  const set = (change: Partial<PersonDetails>) =>
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
        <DetailFields
          details={details}
          requiresDriverLicense={form.requiresDriverLicense}
          set={set}
        />
      </StepCard>
    </>
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
            Back to My documents
          </ButtonLink>
        </>
      }
      title="Background check submitted"
    >
      {error && <Toast tone="danger">{error}</Toast>}
      <p>
        Checkr is preparing your report. {form.organizationName} sees the result
        when it’s ready, and Checkr contacts you if it needs anything else. You
        can return to My documents to check its progress. We’ll also email you
        when the report is ready for your organization to review.
      </p>
    </Card>
  );
}

function initialAnswers(form: ScreeningFormData): Answers {
  return {
    authorize: false,
    copyRequested: false,
    details: emptyDetails(form.workLocation.state),
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

function submission(
  answers: Answers,
  notices: string[],
  form: Pick<ScreeningFormData, "disclosureFingerprint" | "requestRevision">,
) {
  const { residenceState, ...candidate } = answers.details;
  return {
    acknowledgments: {
      disclosure: answers.disclosure,
      stateNotices: notices.filter((state) => answers.notices.includes(state)),
      summaryOfRights: answers.summaryOfRights,
    },
    candidate,
    copyRequested: answers.copyRequested,
    disclosureFingerprint: form.disclosureFingerprint,
    requestRevision: form.requestRevision,
    residenceState,
    signature: {
      authorize: answers.authorize,
      electronicRecords: answers.electronicRecords,
      name: answers.signatureName,
    },
  };
}
