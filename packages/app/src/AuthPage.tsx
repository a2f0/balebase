import { legalLinks, productName } from "@balebase/ui/brand";
import {
  Banner,
  Button,
  cx,
  Field,
  Icon,
  type IconName,
  Logo,
  Toast,
} from "@balebase/ui/react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { AuthFields, type AuthMode } from "./AuthFields";
import { authClient } from "./authClient";
import { authCallbackUrl, websiteUrl } from "./config";
import { throwIfRefused } from "./errors";
import { nativeHost } from "./host";
import { useAction } from "./useAction";
import { useSavedSignIn } from "./useSavedSignIn";

export type AuthenticationAction = "sign-in" | "sign-up";
type AuthVariant = "add-account" | "default";
// This flow explicitly refreshes the session only after every required factor.
// Better Auth's automatic password-sign-in refresh would otherwise unmount the
// pending MFA challenge when the server correctly returns no session yet.
const deferredSessionRefresh = { disableSignal: true } as const;

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
        variant={variant}
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

interface AuthActionInput {
  confirmation: string;
  email: string;
  mode: AuthMode;
  name: string;
  onAuthenticated: (action: AuthenticationAction) => Promise<void>;
  onLeaveReset: () => Promise<void>;
  password: string;
  passwordNeedsSaving: boolean;
  resetToken: string | null;
  termsAccepted: boolean;
}

interface AuthActionResult {
  nextMode?: AuthMode;
  notice?: string;
  twoFactorRequired?: boolean;
}

async function performAuthAction(
  input: AuthActionInput,
): Promise<AuthActionResult> {
  const { mode } = input;
  if (mode === "sign-up" && !input.termsAccepted) {
    throw new Error(
      "You must agree to the Terms of Service to create an account.",
    );
  }
  if (
    (mode === "reset" || mode === "sign-up") &&
    input.password !== input.confirmation
  ) {
    throw new Error("Passwords do not match.");
  }

  if (mode === "sign-in") {
    const result = await authClient.signIn.email(
      passwordSignInInput(input.email, input.password),
    );
    throwIfRefused(result.error, "Authentication failed.");
    if (requiresTwoFactor(result.data)) {
      return { twoFactorRequired: true };
    }
    if (input.passwordNeedsSaving) {
      offerToSavePassword(input.email, input.password);
    }
    await input.onAuthenticated("sign-in");
    return {};
  }

  if (mode === "sign-up") {
    const result = await authClient.signUp.email({
      callbackURL: authCallbackUrl("/?verified=true"),
      email: input.email,
      fetchOptions: deferredSessionRefresh,
      name: input.name,
      password: input.password,
      termsAccepted: true,
    });
    throwIfRefused(result.error, "Authentication failed.");
    const signInResult = await authClient.signIn.email(
      passwordSignInInput(input.email, input.password),
    );
    throwIfRefused(signInResult.error, "Authentication failed.");
    offerToSavePassword(input.email, input.password);
    await input.onAuthenticated("sign-up");
    return {
      notice:
        "Account created. Check your inbox when you’re ready to verify your email.",
    };
  }

  if (mode === "forgot") {
    const result = await authClient.requestPasswordReset({
      email: input.email,
      redirectTo: authCallbackUrl("/reset-password"),
    });
    throwIfRefused(result.error, "Authentication failed.");
    return { notice: "If that account exists, a reset link is on its way." };
  }

  if (!input.resetToken) {
    throw new Error("This reset link is missing its token.");
  }

  const result = await authClient.resetPassword({
    newPassword: input.password,
    token: input.resetToken,
  });
  throwIfRefused(result.error, "Authentication failed.");
  await input.onLeaveReset();
  return {
    nextMode: "sign-in" as const,
    notice: "Password updated. Sign in with your new password.",
  };
}

/**
 * Once the password and any second factor pass, a native shell offers to save
 * the password (see NativeHost.savePassword). Declining or failing to save it
 * never holds up signing in.
 */
function offerToSavePassword(email: string, password: string) {
  void nativeHost()
    ?.savePassword(email, password)
    .catch(() => undefined);
}

function TwoFactorChallenge({
  focusHeading,
  onCancel,
  onVerified,
  variant,
}: {
  focusHeading: boolean;
  onCancel: () => Promise<void> | void;
  onVerified: () => Promise<void>;
  variant: AuthVariant;
}) {
  const [backupCode, setBackupCode] = useState(false);
  const { busy, error, run, setError } = useAction("Something went wrong.");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const result = backupCode
        ? await authClient.twoFactor.verifyBackupCode({
            code: code.trim(),
            trustDevice,
          })
        : await authClient.twoFactor.verifyTotp({
            code: code.replace(/\D/g, ""),
            trustDevice,
          });
      throwIfRefused(result.error, "Authentication failed.");
      await onVerified();
    });
  }

  function chooseBackupCode(nextBackupCode: boolean) {
    setBackupCode(nextBackupCode);
    setCode("");
    setError(undefined);
  }

  return (
    <AuthLayout>
      <AuthHeading
        description={
          backupCode
            ? "Enter one of the recovery codes you saved when you turned on two-factor authentication."
            : "Enter the six-digit code from your authenticator app."
        }
        eyebrow="Two-step verification"
        focusOnMount={focusHeading}
        title="Confirm it’s you"
      />
      <TwoFactorForm
        backupCode={backupCode}
        busy={busy}
        code={code}
        error={error}
        onCode={setCode}
        onSubmit={verify}
        onTrustDevice={setTrustDevice}
        submitLabel={
          variant === "add-account"
            ? "Verify and add account"
            : "Verify and sign in"
        }
        trustDevice={trustDevice}
      />
      <div className="authLinks">
        <Button
          disabled={busy}
          onClick={() => chooseBackupCode(!backupCode)}
          variant="link"
        >
          {backupCode ? "Use an authenticator code" : "Use a recovery code"}
        </Button>
        <Button
          disabled={busy}
          icon="arrowLeft"
          onClick={() => void onCancel()}
          variant="link"
        >
          {variant === "add-account"
            ? "Cancel and return to your account"
            : "Back to sign in"}
        </Button>
      </div>
    </AuthLayout>
  );
}

function TwoFactorForm({
  backupCode,
  busy,
  code,
  error,
  onCode,
  onSubmit,
  onTrustDevice,
  submitLabel,
  trustDevice,
}: {
  backupCode: boolean;
  busy: boolean;
  code: string;
  error: string | undefined;
  onCode: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onTrustDevice: (trustDevice: boolean) => void;
  submitLabel: string;
  trustDevice: boolean;
}) {
  return (
    <form
      autoComplete="on"
      className="formGrid"
      method="post"
      onSubmit={(event) => void onSubmit(event)}
    >
      <Field label={backupCode ? "Recovery code" : "Authentication code"}>
        <input
          autoCapitalize="none"
          autoComplete={backupCode ? "off" : "one-time-code"}
          className={cx("input authCode", !backupCode && "authCodeDigits")}
          id="two-factor-code"
          inputMode={backupCode ? "text" : "numeric"}
          maxLength={backupCode ? 32 : 8}
          onChange={(event) => onCode(event.target.value)}
          pattern={backupCode ? undefined : "[0-9 ]{6,8}"}
          required
          spellCheck={false}
          value={code}
        />
      </Field>
      <label className="check">
        <input
          checked={trustDevice}
          onChange={(event) => onTrustDevice(event.target.checked)}
          type="checkbox"
        />
        <span>Trust this device for 30 days</span>
      </label>
      {error && <Toast tone="danger">{error}</Toast>}
      <Button block busy={busy} size="lg" type="submit" variant="primary">
        {busy ? "Verifying…" : submitLabel}
      </Button>
    </form>
  );
}

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="authShell">
      <AuthAside />
      <main className="authMain">
        <div className="authPanel">{children}</div>
        <AuthLegalLinks />
      </main>
    </div>
  );
}

function AuthHeading({
  description,
  eyebrow,
  focusOnMount = false,
  title,
}: {
  description: string;
  eyebrow: string;
  focusOnMount?: boolean;
  title: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shownTitle = useRef(focusOnMount ? undefined : title);
  // Switching forms removes the control that had focus. Move focus to the new
  // form's heading, whether the form replaced its title or was mounted in place
  // of another, so keyboard and screen-reader users start there rather than at
  // the top of the page; the first form keeps the page's initial focus.
  useEffect(() => {
    if (shownTitle.current === title) return;
    shownTitle.current = title;
    heading.current?.focus();
  }, [title]);
  return (
    <header className="authHeading">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="authTitle" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="authIntro">{description}</p>
    </header>
  );
}

function AuthLegalLinks() {
  return (
    <nav aria-label="Legal" className="authLegal">
      {legalLinks.map((link) => (
        <a href={`${websiteUrl}${link.href}`} key={link.href}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}

const asidePoints: ReadonlyArray<{
  description: string;
  icon: IconName;
  title: string;
}> = [
  {
    description: "Run inspections from reusable templates.",
    icon: "audits",
    title: "Audits and checklists",
  },
  {
    description: "Capture what needs fixing, right where you find it.",
    icon: "camera",
    title: "Issues with photos",
  },
  {
    description: "Invite your team and require two-factor authentication.",
    icon: "security",
    title: "Team access you control",
  },
];

function AuthAside() {
  return (
    <aside className="authAside onDark">
      <div className="authAsideInner">
        <a aria-label={`${productName} home`} className="authBrand" href="/">
          <Logo />
        </a>
        <div className="authAsideCopy">
          <p className="eyebrow eyebrowDot">Private by design</p>
          <p className="title authHeadline">
            Keep what matters.{" "}
            <span className="serifAccent">Lose the noise.</span>
          </p>
          <p className="lead">
            One quiet workspace for your audits, the issues they turn up, and
            the business records and files behind them.
          </p>
        </div>
        <ul className="authPoints">
          {asidePoints.map((point) => (
            <li className="authPoint" key={point.title}>
              <span className="authPointIcon">
                <Icon name={point.icon} />
              </span>
              <span className="authPointText">
                <strong>{point.title}</strong>
                <span>{point.description}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
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

export function requiresTwoFactor(data: unknown) {
  return (
    typeof data === "object" &&
    data !== null &&
    "twoFactorRedirect" in data &&
    data.twoFactorRedirect === true
  );
}

export function passwordSignInInput(email: string, password: string) {
  return { email, fetchOptions: deferredSessionRefresh, password };
}
