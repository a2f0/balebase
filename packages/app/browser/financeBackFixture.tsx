import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FinanceSection } from "../src/finance/FinanceSection";
import { useWorkspaceNavigation } from "../src/workspace/navigationGuard";
import { recordIdForPath } from "../src/workspace/workspacePaths";
import { financeResponse } from "./historyScrollFixture";

/** Transactions Finance holds here: three of the overview's pages. */
const financeTotal = 750;

/**
 * Finance navigated as the workspace navigates, with a short page for each
 * transaction in place of its record page.
 */
function Section() {
  const [pathname, setPathname] = useState(location.pathname);
  const navigate = useWorkspaceNavigation(setPathname);
  const id = recordIdForPath(pathname, "/finance/transactions");
  return (
    <FinanceSection
      navigate={navigate}
      opensByPayee={false}
      pathname={pathname}
      record={id === undefined ? undefined : <p className="record">{id}</p>}
      scope={undefined}
    />
  );
}

export function mount(element: HTMLElement) {
  window.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      financeResponse(new URL(String(input)), financeTotal),
    { preconnect: () => {} },
  );
  createRoot(element).render(<Section />);
}
