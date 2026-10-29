import {
  Button,
  cx,
  EmptyState,
  LoadingState,
  Logo,
  promptDialog,
} from "@balebase/ui/react";
import type { SigningField, SigningView } from "@balebase/validators/signing";
import { useCallback, useState } from "react";
import { boxStyle, ContractPages } from "./ContractDocument";
import { fieldTypeLabel, initialsFor } from "./contractFields";
import { SignatureDialog } from "./SignatureDialog";
import { ApiDownload } from "./shared/ApiDownload";
import { api } from "./shared/apiClient";
import { formatCalendarDate } from "./shared/labels";
import { useAction } from "./shared/useAction";
import { useLoad } from "./shared/useLoad";

/** The page a signer opens from their emailed link; needs no account. */
export function SigningPage({ token }: { token: string }) {
  const {
    data: view,
    error,
    setData: setView,
  } = useLoad(
    useCallback(() => api.signing.get(token), [token]),
    "This link could not be opened.",
  );
  return (
    <div className="signingShell">
      <header className="signingTopBar">
        <Logo />
        {view && (
          <span className="signingFrom">
            From{" "}
            {view.contract.senderName ? `${view.contract.senderName}, ` : ""}
            {view.contract.organizationName}
          </span>
        )}
      </header>
      <main className="signingMain">
        {error && (
          <EmptyState icon="error" title="This signing link isn’t valid">
            {error}
          </EmptyState>
        )}
        {!view && !error && <LoadingState label="Opening document…" />}
        {view &&
          (view.canSign ? (
            <SigningSession onFinished={setView} token={token} view={view} />
          ) : (
            <SigningOutcome token={token} view={view} />
          ))}
      </main>
    </div>
  );
}

function useSigningSession(
  token: string,
  view: SigningView,
  onFinished: (view: SigningView) => void,
) {
  const [signature, setSignature] = useState<string>();
  const [initials, setInitials] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [dialog, setDialog] = useState<"initials" | "signature" | null>(null);
  const action = useAction("Could not complete signing.");
  const remaining = view.fields.filter((field) => {
    if (field.type === "signature") return !signature;
    if (field.type === "initials") return !initials;
    if (field.type === "text")
      return field.required && !values[field.id]?.trim();
    return false;
  }).length;

  const finishWith = (work: () => Promise<unknown>) =>
    action.run(async () => {
      await work();
      onFinished(await api.signing.get(token));
    });
  return {
    busy: action.busy,
    consent,
    decline: async () => {
      const reason = await askDeclineReason();
      if (reason === null) return;
      void finishWith(() => api.signing.decline(token, reason));
    },
    dialog,
    error: action.error,
    finish: () =>
      finishWith(() =>
        api.signing.sign(token, { consent, initials, signature, values }),
      ),
    initials,
    remaining,
    setConsent,
    setDialog,
    setInitials,
    setSignature,
    setValues,
    signature,
    values,
  };
}

type Session = ReturnType<typeof useSigningSession>;

function SigningSession({
  onFinished,
  token,
  view,
}: {
  onFinished: (view: SigningView) => void;
  token: string;
  view: SigningView;
}) {
  const session = useSigningSession(token, view, onFinished);
  const { contract, recipient } = view;
  const due = contract.dueDate
    ? ` · due ${formatCalendarDate(contract.dueDate)}`
    : "";
  return (
    <>
      <section className="signingIntro">
        <p className="eyebrow">Please review and sign</p>
        <h1 className="pageTitle">{contract.title}</h1>
        {contract.message && (
          <p className="signingMessage">{contract.message}</p>
        )}
        <p className="contractHint">
          Signing as {recipient.name} ({recipient.email}){due}. Complete the
          highlighted fields, then finish.
        </p>
        <div>
          <ApiDownload
            filename="contract.pdf"
            href={api.signing.documentUrl(token)}
            icon="download"
            size="sm"
          >
            Download the PDF to read
          </ApiDownload>
        </div>
      </section>
      <ContractPages
        load={() => fetchSigningDocument(token)}
        renderOverlay={(page) =>
          view.fields
            .filter((field) => field.page === page.number)
            .map((field) => (
              <SigningFieldBox
                field={field}
                key={field.id}
                name={recipient.name}
                session={session}
              />
            ))
        }
      />
      <SigningFooter session={session} />
      {session.dialog && (
        <SignatureDialog
          defaultText={
            session.dialog === "signature"
              ? recipient.name
              : initialsFor(recipient.name)
          }
          mode={session.dialog}
          onAdopt={(dataUrl) => {
            if (session.dialog === "signature") session.setSignature(dataUrl);
            else session.setInitials(dataUrl);
            session.setDialog(null);
          }}
          onClose={() => session.setDialog(null)}
        />
      )}
    </>
  );
}

function SigningFieldBox({
  field,
  name,
  session,
}: {
  field: SigningField;
  name: string;
  session: Session;
}) {
  if (field.type === "signature" || field.type === "initials")
    return <SigningImageField field={field} session={session} />;
  if (field.type === "text")
    return <SigningTextField field={field} session={session} />;
  // The signed copy is stamped with the UTC date.
  const today = formatCalendarDate(new Date().toISOString().slice(0, 10));
  return (
    <span className="contractField signingFieldFixed" style={boxStyle(field)}>
      <span className="signingFieldText">
        {field.type === "name" ? name : today}
      </span>
    </span>
  );
}

/** A signature or initials box; opens the dialog to adopt one. */
function SigningImageField({
  field,
  session,
}: {
  field: SigningField;
  session: Session;
}) {
  const mode = field.type === "signature" ? "signature" : "initials";
  const image = mode === "signature" ? session.signature : session.initials;
  return (
    <button
      aria-label={image ? `Change your ${mode}` : `Add your ${mode}`}
      className={cx("contractField signingField", !image && "signingFieldTodo")}
      onClick={() => session.setDialog(mode)}
      style={boxStyle(field)}
      type="button"
    >
      {image ? (
        <img alt="" className="signingFieldImage" src={image} />
      ) : (
        <span className="contractFieldLabel">
          {mode === "signature" ? "Sign here" : "Initial"}
        </span>
      )}
    </button>
  );
}

function SigningTextField({
  field,
  session,
}: {
  field: SigningField;
  session: Session;
}) {
  const value = session.values[field.id] ?? "";
  const label = field.label ?? fieldTypeLabel(field.type);
  return (
    <input
      aria-label={field.label ?? "Text"}
      className={cx(
        "signingFieldInput",
        field.required && !value.trim() && "signingFieldTodo",
      )}
      maxLength={500}
      onChange={(event) =>
        session.setValues((current) => ({
          ...current,
          [field.id]: event.target.value,
        }))
      }
      placeholder={field.required ? label : `${label} (optional)`}
      style={boxStyle(field)}
      value={value}
    />
  );
}

function SigningFooter({ session }: { session: Session }) {
  const ready = session.remaining === 0 && session.consent;
  return (
    <footer className="signingFooter">
      {/* Beside Finish, so a rejected signature is seen where it was tapped. */}
      {session.error && (
        <p className="fieldError signingFooterError" role="alert">
          {session.error}
        </p>
      )}
      <label className="check signingConsent">
        <input
          checked={session.consent}
          onChange={(event) => session.setConsent(event.target.checked)}
          type="checkbox"
        />
        I agree to use electronic records and signatures, and that my electronic
        signature is as valid as one written by hand.
      </label>
      <div className="signingFooterActions">
        <span className="contractHint">
          {session.remaining > 0
            ? `${session.remaining} ${session.remaining === 1 ? "field" : "fields"} left`
            : "All fields complete"}
        </span>
        <Button
          disabled={session.busy}
          onClick={session.decline}
          variant="ghost"
        >
          Decline
        </Button>
        <Button
          busy={session.busy}
          disabled={!ready}
          icon="signature"
          onClick={() => void session.finish()}
          variant="primary"
        >
          Finish
        </Button>
      </div>
    </footer>
  );
}

function SigningOutcome({ token, view }: { token: string; view: SigningView }) {
  const { contract, recipient } = view;
  const download = contract.status === "completed" && (
    <ApiDownload
      filename="signed-contract.pdf"
      href={api.signing.finalUrl(token)}
      icon="download"
      variant="primary"
    >
      Download the signed copy
    </ApiDownload>
  );
  if (contract.status === "voided") {
    return (
      <EmptyState icon="void" title="This contract was voided">
        {contract.organizationName} voided “{contract.title}”. You don’t need to
        sign it.
      </EmptyState>
    );
  }
  if (recipient.status === "declined") {
    return (
      <EmptyState icon="error" title="You declined to sign">
        We let {contract.senderName ?? contract.organizationName} know.
      </EmptyState>
    );
  }
  if (recipient.status === "signed" && contract.status === "declined") {
    return (
      <EmptyState icon="error" title="Another signer declined">
        You signed “{contract.title}”, but another signer declined it, so it
        will not be completed.
      </EmptyState>
    );
  }
  if (recipient.status === "signed") {
    return (
      <EmptyState actions={download} icon="success" title="You’ve signed">
        {contract.status === "completed"
          ? "Everyone has signed. A copy with its certificate of completion was emailed to you."
          : "We’ll email you the signed copy once everyone has signed."}
      </EmptyState>
    );
  }
  return (
    <EmptyState icon="contract" title="This contract can’t be signed now">
      {contract.status === "declined"
        ? "Another signer declined it."
        : "It isn’t your turn to sign yet. We’ll email you when it is."}
    </EmptyState>
  );
}

async function fetchSigningDocument(token: string) {
  const response = await api.signing.document(token).catch(() => undefined);
  if (!response) throw new Error("The document could not be loaded.");
  return response.arrayBuffer();
}

function askDeclineReason() {
  return promptDialog({
    confirmLabel: "Decline to sign",
    label: "Reason (optional)",
    maxLength: 500,
    message: "The sender will be told.",
    multiline: true,
    title: "Decline to sign?",
    tone: "danger",
  });
}
