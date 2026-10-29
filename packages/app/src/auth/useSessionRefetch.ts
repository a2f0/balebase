import { useEffect, useState } from "react";

/**
 * Tells a background session refetch from one the sign-in page asks for.
 * Better Auth marks every refetch without a session as pending, and returning
 * to the app refetches it. Swapping the sign-in page for a loading screen then
 * would drop a pending two-factor challenge while the person fetches the code
 * from another app. So once the session has loaded, the sign-in page stays
 * through refetches it didn't ask for, and ignores their failures. After
 * signing in, it requests the new session, which still loads and reports a
 * failure as before, until an answer arrives.
 */
export function useSessionRefetch(
  session: unknown,
  isPending: boolean,
  error: unknown,
  refetch: () => Promise<unknown>,
) {
  const answered = !isPending && !error;
  const [loaded, setLoaded] = useState(answered);
  const [requested, setRequested] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed session answers a request too.
  useEffect(() => {
    if (!answered) return;
    setLoaded(true);
    setRequested(false);
  }, [answered, session]);
  return {
    background: (loaded || answered) && !requested,
    request: () => {
      setRequested(true);
      return refetch();
    },
  };
}
