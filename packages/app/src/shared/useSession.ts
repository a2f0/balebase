import { useStore } from "better-auth/react";
import { balebase } from "../balebase";

/**
 * The signed-in session, kept current: the SDK's Better Auth session store,
 * read the way Better Auth's React client reads it. A host change (tests
 * only) brings a new store, which starts with no session.
 */
export function useSession() {
  return useStore(balebase().auth.useSession);
}
