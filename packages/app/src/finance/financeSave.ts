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
  // A refusal that lands after leaving this page still means access ended,
  // so it is reported; Finance's `onRefused` is bound to the organization
  // the save began in and leaves another organization's view alone.
  const run: RunChange = (change) =>
    action.run(
      async () => {
        try {
          const message = await change();
          await onChanged();
          return message;
        } catch (cause) {
          if (refused(cause)) await onRefused(cause);
          throw cause;
        }
      },
      (message) => message,
    );
  return { ...action, run };
}
