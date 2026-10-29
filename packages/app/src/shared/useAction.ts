import { useCallback, useState } from "react";
import { type ErrorNotice, errorNotice } from "./errors";

/**
 * Runs a mutation: marks it busy, clears the last outcome, then shows its
 * error or the optional success notice. Resolves whether the work succeeded.
 * `failure` keeps the error's upgrade flag for `ErrorToast`.
 */
export function useAction(fallback: string) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ErrorNotice>();
  const [notice, setNotice] = useState<string>();
  const setError = useCallback((message: string | undefined) => {
    setFailure(message === undefined ? undefined : { message, upgrade: false });
  }, []);
  const run = useCallback(
    async <T>(
      work: () => Promise<T>,
      success?: string | ((result: T) => string | undefined),
    ) => {
      setBusy(true);
      setFailure(undefined);
      setNotice(undefined);
      try {
        const result = await work();
        if (success)
          setNotice(typeof success === "function" ? success(result) : success);
        return true;
      } catch (cause) {
        setFailure(errorNotice(cause, fallback));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fallback],
  );
  return {
    busy,
    error: failure?.message,
    failure,
    notice,
    run,
    setError,
    setNotice,
  };
}
