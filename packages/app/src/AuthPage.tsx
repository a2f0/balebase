import { Banner, Button, Toast } from "@balebase/ui/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AuthFields, type AuthMode } from "./AuthFields";
import { AuthHeading, AuthLayout } from "./AuthLayout";
import {
  type AuthenticationAction,
  offerToSavePassword,
  performAuthAction,
} from "./authActions";
import { websiteUrl } from "./config";
import { TwoFactorChallenge } from "./TwoFactorChallenge";
import { useAction } from "./useAction";
import { useSavedSignIn } from "./useSavedSignIn";

type AuthVariant = "add-account" | "default";

interface AuthPageProps {
  initialError?: string | undefined;
  initialMode?: AuthMode;
  initialNotice?: string | undefined;
  /** Initial notices are guidance unless the caller says they confirm something. */
  initialNoticeTone?: "info" | "success";
  onAuthenticated: (action: AuthenticationAction) => Promise<void>;
  onCancel?: (() => Promise<void> | void) | undefined;
  /**
   * Leaves the reset link, once its token is spent or when the person goes back
   * to sign in instead; sign-in continues here.
   */
  onLeaveReset: () => Promise<void>;
  variant?: AuthVariant;
}

const content: Record<
  AuthMode,
  { button: string; eyebrow: string; title: string }
> = {
  forgot: {
    button: "Send reset link",
    eyebrow: "Account recovery",
    title: "Reset your password",
  },
  reset: {
    button: "Set new password",
    eyebrow: "Account recovery",
    title: "Choose a new password",
  },
  "sign-in": {
    button: "Sign in",
    eyebrow: "Welcome back",
    title: "Enter your workspace",
  },
  "sign-up": {
    button: "Create account",
    eyebrow: "Get started",
    title: "Create your workspace",
  },
};

export function AuthPage({
  initialError,
  initialMode = "sign-in",
  initialNotice,
  initialNoticeTone = "info",
  onAuthenticated,
  onCancel,
  onLeaveReset,
  variant = "default",
}: AuthPageProps) {
  const auth = useAuthPageState({
    initialError,
    initialMode,
    initialNotice,
    onAuthenticated,
    onCancel,
    onLeaveReset,
  });
  // A form shown after the first one takes focus; see AuthHeading.
  const firstFormShown = useRef(false);
  useEffect(() => {
    firstFormShown.current = true;
  }, []);
  const focusHeading = firstFormShown.current;

  if (auth.twoFactorRequired) {
    return (
      <TwoFactorChallenge
        addingAccount={variant === "add-account"}
        focusHeading={focusHeading}
        onCancel={
          onCancel
            ? auth.cancel
            : () => {
                auth.setTwoFactorRequired(false);
                auth.setPassword("");
              }
        }
        onVerified={async () => {
          if (auth.passwordNeedsSaving) {
            offerToSavePassword(auth.email, auth.password);
          }
          await onAuthenticated("sign-in");
        }}
      />
    );
  }

  return (
    <CredentialAuthPage
      {...auth}
      copy={contentFor(auth.mode, variant)}
      focusHeading={focusHeading}
      // Action results confirm; a notice that arrived with the page keeps its tone.
      noticeTone={auth.notice === initialNotice ? initialNoticeTone : "success"}
      onCancel={onCancel ? auth.cancel : undefined}
      onMode={
        auth.mode === "reset" ? () => void auth.leaveReset() : auth.chooseMode
      }
      onSubmit={auth.submit}
      variant={variant}
    />
  );
}

function useAuthPageState({
  initialError,
  initialMode,
  initialNotice,
  onAuthenticated,
  onCancel,
  onLeaveReset,
}: Required<Pick<AuthPageProps, "initialMode">> &
  Pick<
    AuthPageProps,
    | "initialError"
    | "initialNotice"
    | "onAuthenticated"
    | "onCancel"
    | "onLeaveReset"
  >) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const savedSignIn = useSavedSignIn();
  const [passwordNeedsSaving, setPasswordNeedsSaving] = useState(true);
  const [confirmation, setConfirmation] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const { busy, error, setError, runWhileBusy } = useAuthAction(initialError);
  const [notice, setNotice] = useState<string | undefined>(initialNotice);
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const resetToken = new URLSearchParams(window.location.search).get("token");

  function chooseMode(nextMode: AuthMode) {
    savedSignIn.clear();
    setMode(nextMode);
    setError(undefined);
    setNotice(undefined);
    setPassword("");
    setConfirmation("");
    setTermsAccepted(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    const needsSave =
      mode !== "sign-in" ||
      !savedSignIn.isSaved(event.currentTarget, email, password);
    setPasswordNeedsSaving(needsSave);
    await runWhileBusy(async () => {
      const result = await performAuthAction({
        confirmation,
        email,
        mode,
        name,
        onAuthenticated,
        onLeaveReset,
        password,
        passwordNeedsSaving: needsSave,
        resetToken,
        termsAccepted,
      });
      if (result.twoFactorRequired) {
        setTwoFactorRequired(true);
        return;
      }
      if (result.nextMode) chooseMode(result.nextMode);
      setNotice(result.notice);
    });
  }

  const leaveReset = () =>
    runWhileBusy(async () => {
      await onLeaveReset();
      chooseMode("sign-in");
    });

  return {
    busy,
    onInput: savedSignIn.onInput,
    passwordNeedsSaving,
    cancel: () => runWhileBusy(() => onCancel?.()),
    chooseMode,
    confirmation,
    email,
    error,
    leaveReset,
    mode,
    name,
    notice,
    onConfirmation: setConfirmation,
    onEmail: setEmail,
    onName: setName,
    onPassword: setPassword,
    password,
    onTermsAccepted: setTermsAccepted,
    setPassword,
    setTwoFactorRequired,
    submit,
    termsAccepted,
    twoFactorRequired,
  };
}

function useAuthAction(initialError: string | undefined) {
  const action = useAction("Something went wrong.");
  // An error the page opened with, such as an expired link, lasts until the
  // next action.
  const [openingError, setOpeningError] = useState(initialError);
  function setError(message: string | undefined) {
    setOpeningError(undefined);
    action.setError(message);
  }
  async function runWhileBusy(work: () => Promise<void> | void) {
    setOpeningError(undefined);
    await action.run(async () => work());
  }

  return {
    busy: action.busy,
    error: action.error ?? openingError,
    setError,
    runWhileBusy,
  };
}

interface CredentialAuthPageProps {
  onInput: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  confirmation: string;
  copy: { button: string; eyebrow: string; title: string };
  email: string;
  error: string | undefined;
  focusHeading: boolean;
  mode: AuthMode;
  name: string;
  notice: string | undefined;
  noticeTone: "info" | "success";
  onCancel: (() => Promise<void>) | undefined;
  onConfirmation: (value: string) => void;
  onEmail: (value: string) => void;
  onMode: (mode: AuthMode) => void;
  onName: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  password: string;
  termsAccepted: boolean;
  onTermsAccepted: (accepted: boolean) => void;
  variant: AuthVariant;
}

function CredentialAuthPage({
  busy,
  onInput,
  confirmation,
  copy,
  email,
  error,
  focusHeading,
  mode,
  name,
  notice,
  noticeTone,
  onCancel,
  onConfirmation,
  onEmail,
  onMode,
  onName,
  onPassword,
  onSubmit,
  password,
  termsAccepted,
  onTermsAccepted,
  variant,
}: CredentialAuthPageProps) {
  return (
    <AuthLayout>
      <AuthHeading
        description={descriptionFor(mode, variant)}
        eyebrow={copy.eyebrow}
        focusOnMount={focusHeading}
        title={copy.title}
      />

      <form
        autoComplete="on"
        className="formGrid"
        method="post"
        onInput={onInput}
        onSubmit={(event) => void onSubmit(event)}
      >
        {notice && noticeTone === "info" && <Banner>{notice}</Banner>}
        <AuthFields
          confirmation={confirmation}
          email={email}
          mode={mode}
          name={name}
          onConfirmation={onConfirmation}
          onEmail={onEmail}
          onName={onName}
          onPassword={onPassword}
          password={password}
        />

        {mode === "sign-up" && (
          <TermsAgreement
            accepted={termsAccepted}
            onAccepted={onTermsAccepted}
          />
        )}

        {mode === "sign-in" && (
          <Button
            className="authForgot"
            onClick={() => onMode("forgot")}
            variant="link"
          >
            Forgot password?
          </Button>
        )}

        {error && <Toast tone="danger">{error}</Toast>}
        {notice && noticeTone === "success" && (
          <Toast tone="success">{notice}</Toast>
        )}

        <Button block busy={busy} size="lg" type="submit" variant="primary">
          {busy ? "One moment…" : copy.button}
        </Button>
      </form>

      <CredentialAuthLinks
        busy={busy}
        mode={mode}
        onCancel={onCancel}
        onMode={onMode}
      />
    </AuthLayout>
  );
}

function TermsAgreement({
  accepted,
  onAccepted,
}: {
  accepted: boolean;
  onAccepted: (accepted: boolean) => void;
}) {
  return (
    <label className="check">
      <input
        checked={accepted}
        name="terms-accepted"
        onChange={(event) => onAccepted(event.target.checked)}
        required
        type="checkbox"
      />
      <span>
        I agree to the{" "}
        <a href={`${websiteUrl}/terms/`} rel="noreferrer" target="_blank">
          Terms of Service
        </a>{" "}
        and acknowledge the{" "}
        <a href={`${websiteUrl}/privacy/`} rel="noreferrer" target="_blank">
          Privacy Policy
        </a>
        .
      </span>
    </label>
  );
}

function CredentialAuthLinks({
  busy,
  mode,
  onCancel,
  onMode,
}: {
  busy: boolean;
  mode: AuthMode;
  onCancel: (() => Promise<void>) | undefined;
  onMode: (mode: AuthMode) => void;
}) {
  return (
    <div className="authLinks">
      {mode === "sign-in" ? (
        <p>
          New here?{" "}
          <Button onClick={() => onMode("sign-up")} variant="link">
            Create an account
          </Button>
        </p>
      ) : (
        <Button
          icon="arrowLeft"
          onClick={() => onMode("sign-in")}
          variant="link"
        >
          Back to sign in
        </Button>
      )}
      {onCancel && (
        <Button
          disabled={busy}
          icon="arrowLeft"
          onClick={() => void onCancel()}
          variant="link"
        >
          Cancel and return to your account
        </Button>
      )}
    </div>
  );
}

function contentFor(mode: AuthMode, variant: AuthVariant) {
  if (mode === "sign-in" && variant === "add-account") {
    return {
      button: "Add account",
      eyebrow: "Another account",
      title: "Sign in to another account",
    };
  }
  return content[mode];
}

function descriptionFor(mode: AuthMode, variant: AuthVariant) {
  if (mode === "forgot") {
    return "Enter your email and we’ll send you a secure, one-time link.";
  }
  if (mode === "reset") {
    return "Your new password will sign out every existing session.";
  }
  if (mode === "sign-up") {
    return "Start with an email address and a strong password.";
  }
  if (variant === "add-account") {
    return "This account will stay available on this browser so you can switch without signing in again.";
  }
  return "Sign in with the email and password attached to your account.";
}
