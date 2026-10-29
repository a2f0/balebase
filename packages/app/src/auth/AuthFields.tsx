import { Field, PasswordField } from "@balebase/ui/react";

export type AuthMode = "forgot" | "reset" | "sign-in" | "sign-up";

interface AuthFieldsProps {
  confirmation: string;
  email: string;
  mode: AuthMode;
  name: string;
  onConfirmation: (value: string) => void;
  onEmail: (value: string) => void;
  onName: (value: string) => void;
  onPassword: (value: string) => void;
  password: string;
}

export function AuthFields(props: AuthFieldsProps) {
  const { mode } = props;
  const needsPassword =
    mode === "reset" || mode === "sign-in" || mode === "sign-up";
  const needsConfirmation = mode === "reset" || mode === "sign-up";

  return (
    <>
      {mode === "sign-up" && (
        <AuthInput
          autoComplete="name"
          label="Name"
          maxLength={100}
          name="name"
          onValue={props.onName}
          value={props.name}
        />
      )}
      {mode !== "reset" && (
        <AuthInput
          autoCapitalize="none"
          autoComplete={mode === "forgot" ? "email" : "username"}
          inputMode="email"
          label="Email"
          name="email"
          onValue={props.onEmail}
          spellCheck={false}
          type="email"
          value={props.email}
        />
      )}
      {/* Keyed by mode, so a revealed password is hidden on the next form. */}
      {needsPassword && (
        <AuthInput
          key={`${mode}-password`}
          autoComplete={
            mode === "sign-in" ? "current-password" : "new-password"
          }
          help={needsConfirmation ? "Use at least 12 characters." : undefined}
          label={mode === "sign-in" ? "Password" : "New password"}
          maxLength={128}
          minLength={12}
          name="password"
          onValue={props.onPassword}
          type="password"
          value={props.password}
        />
      )}
      {needsConfirmation && (
        <AuthInput
          key={`${mode}-confirmation`}
          autoComplete="new-password"
          label="Confirm password"
          maxLength={128}
          minLength={12}
          name="password-confirmation"
          onValue={props.onConfirmation}
          type="password"
          value={props.confirmation}
        />
      )}
    </>
  );
}

interface AuthInputProps {
  autoCapitalize?: "none";
  autoComplete: string;
  help?: string | undefined;
  inputMode?: "email";
  label: string;
  maxLength?: number;
  minLength?: number;
  name: string;
  onValue: (value: string) => void;
  spellCheck?: boolean;
  type?: "email" | "password";
  value: string;
}

function AuthInput({
  help,
  label,
  onValue,
  type = undefined,
  ...props
}: AuthInputProps) {
  if (type === "password") {
    return (
      <PasswordField
        {...props}
        hint={help}
        id={props.name}
        label={label}
        onChange={(event) => onValue(event.target.value)}
        required
      />
    );
  }
  return (
    <Field hint={help} label={label}>
      <input
        {...props}
        className="input"
        id={props.name}
        onChange={(event) => onValue(event.target.value)}
        required
        type={type}
      />
    </Field>
  );
}
