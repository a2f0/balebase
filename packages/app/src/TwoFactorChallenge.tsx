import { Button, cx, Field, Toast } from "@balebase/ui/react";
import { type FormEvent, useState } from "react";
import { AuthHeading, AuthLayout } from "./AuthLayout";
import { authClient } from "./shared/authClient";
import { throwIfRefused } from "./shared/errors";
import { useAction } from "./shared/useAction";

export function TwoFactorChallenge({
  addingAccount,
  focusHeading,
  onCancel,
  onVerified,
}: {
  addingAccount: boolean;
  focusHeading: boolean;
  onCancel: () => Promise<void> | void;
  onVerified: () => Promise<void>;
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
          addingAccount ? "Verify and add account" : "Verify and sign in"
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
          {addingAccount
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
