import { useEffect, useRef } from "react";
import { useAction } from "../shared/useAction";
import { refused } from "./transactionCache";

/** Runs a change; resolves a success message, or throws its failure. */
export type RunChange = (change: () => Promise<string>) => Promise<boolean>;

/**
 * A Finance settings page's saves (categories, rules): each reloads Finance
 * once it lands, reports a refusal as access ending, and shows its message.
 */
export function useFinanceSave(
  fallback: string,
  onChanged: () => Promise<void>,
  onRefused: (cause: unknown) => Promise<void>,
) {
  const action = useAction(fallback);
  // A refusal that lands after its page closed is stale: Finance may already
  // show another organization's data, which it must not clear. (The closing
  // reload is safe either way: Finance's reloads use the current page's
  // loader.)
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run: RunChange = (change) =>
    action.run(
      async () => {
        try {
          const message = await change();
          await onChanged();
          return message;
        } catch (cause) {
          if (refused(cause) && mounted.current) await onRefused(cause);
          throw cause;
        }
      },
      (message) => message,
    );
  return { ...action, run };
}
