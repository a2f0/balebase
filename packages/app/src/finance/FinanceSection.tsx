import { type ReactNode, useCallback } from "react";
import { KeptPage } from "../workspace/KeptPage";
import { Finance } from "./Finance";
import { type CacheScope, clears, onCleared } from "./transactionCache";
import { useCacheScope } from "./useCacheScope";

/**
 * Finance's pages. A record page shows over the Finance page it was opened
 * from, which Back returns to as it was left (see `KeptPage`). Clearing the
 * saved transactions, in any tab, discards a hidden page, so Back never
 * shows transactions whose access ended while a record showed.
 */
export function FinanceSection({
  navigate,
  opensByPayee,
  pathname,
  record,
  scope: givenScope,
}: {
  navigate: (path: string) => void;
  opensByPayee: boolean;
  pathname: string;
  /** The record page `pathname` names, if it names one. */
  record: ReactNode | undefined;
  /** Whose saved transactions this device reads; memory only without it. */
  scope: CacheScope | undefined;
}) {
  const scope = useCacheScope(givenScope);
  const discardWhen = useCallback(
    (discard: () => void) =>
      scope &&
      onCleared((cleared) => {
        if (clears(cleared, scope)) discard();
      }),
    [scope],
  );
  return (
    <KeptPage
      discardWhen={discardWhen}
      page={(path) => (
        <Finance
          onNavigate={navigate}
          opensByPayee={opensByPayee}
          pathname={path}
          scope={scope}
        />
      )}
      pathname={pathname}
      record={record}
    />
  );
}
