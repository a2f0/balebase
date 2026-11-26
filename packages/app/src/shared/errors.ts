import { errorMessage } from "@balebase/client-sdk";

/** An error whose fix is a Pro upgrade on the Billing page. */
export class UpgradeRequiredError extends Error {
  readonly code = "UPGRADE_REQUIRED";
}

export interface ErrorNotice {
  message: string;
  /** The API marked it `UPGRADE_REQUIRED`, so Billing can resolve it. */
  upgrade: boolean;
}

/** Better Auth reports a refused request in `error` instead of throwing. */
export function throwIfRefused(
  error: { message?: string | undefined } | null,
  fallback: string,
) {
  if (error) throw new Error(error.message ?? fallback);
}

export function errorNotice(cause: unknown, fallback: string): ErrorNotice {
  return {
    message: errorMessage(cause, fallback),
    upgrade:
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "UPGRADE_REQUIRED",
  };
}
