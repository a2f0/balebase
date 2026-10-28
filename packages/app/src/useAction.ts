import { useCallback, useState } from "react";
import { errorMessage } from "./errors";

/**
 * Runs a mutation: marks it busy, clears the last outcome, then shows its
 * error or the optional success notice. Resolves whether the work succeeded.
 */
export function useAction(fallback: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const run = useCallback(
    async <T>(
      work: () => Promise<T>,
      success?: string | ((result: T) => string | undefined),
    ) => {
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await work();
        setNotice(typeof success === "function" ? success(result) : success);
        return true;
      } catch (cause) {
        setError(errorMessage(cause, fallback));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fallback],
  );
  return { busy, error, notice, run, setError, setNotice };
}
