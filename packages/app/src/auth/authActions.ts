import { nativeHost } from "../host";
import { authClient } from "../shared/authClient";
import { authCallbackUrl } from "../shared/config";
import { throwIfRefused } from "../shared/errors";
import type { AuthMode } from "./AuthFields";

export type AuthenticationAction = "sign-in" | "sign-up";

// This flow explicitly refreshes the session only after every required factor.
// Better Auth's automatic password-sign-in refresh would otherwise unmount the
// pending MFA challenge when the server correctly returns no session yet.
const deferredSessionRefresh = { disableSignal: true } as const;

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

export async function performAuthAction(
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
export function offerToSavePassword(email: string, password: string) {
  void nativeHost()
    ?.savePassword(email, password)
    .catch(() => undefined);
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
