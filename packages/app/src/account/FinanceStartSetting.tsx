import { Card, Toast } from "@balebase/ui/react";
import { useEffect, useReducer, useRef } from "react";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import {
  financeStartTransition,
  initialFinanceStart,
  shownFinanceStart,
} from "./financeStartState";

/**
 * Where Finance starts: the sidebar's Finance can open on uncategorized
 * expenses rather than every transaction, and its transactions grouped by
 * payee rather than as a list. The two combine. Each is saved to the account,
 * so it follows the person to every device.
 */
export function FinanceStartSetting({
  opensByPayee,
  opensUncategorized,
  onSessionChanged,
}: {
  opensByPayee: boolean;
  opensUncategorized: boolean;
  /** Reloads the session, which carries the saved choices. */
  onSessionChanged: () => Promise<unknown>;
}) {
  return (
    <Card
      description="Choose what opens when you select Finance in the sidebar."
      title="Finance"
    >
      <div className="stack">
        <SettingSwitch
          label="Open Finance on uncategorized expenses"
          onSessionChanged={onSessionChanged}
          save={(value) => api.accountSettings.updateFinanceStart(value)}
          saved={opensUncategorized}
        />
        <SettingSwitch
          label="Group transactions by payee"
          onSessionChanged={onSessionChanged}
          save={(value) => api.accountSettings.updateFinanceView(value)}
          saved={opensByPayee}
        />
      </div>
    </Card>
  );
}

/**
 * One account switch. It shows the saved choice, or the choice being saved
 * while it saves, through its own save machine (`financeStartState.ts`), so
 * the switches save independently.
 */
function SettingSwitch({
  label,
  onSessionChanged,
  save,
  saved,
}: {
  label: string;
  onSessionChanged: () => Promise<unknown>;
  save: (value: boolean) => Promise<unknown>;
  saved: boolean;
}) {
  const [state, dispatch] = useReducer(
    financeStartTransition,
    initialFinanceStart,
  );
  // A save outlived by this page (another account opened) must not reload
  // the session: that reload belongs to the account it started under.
  const active = useRef(true);
  const requests = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function change(value: boolean) {
    const request = ++requests.current;
    dispatch({ request, type: "saveStarted", value });
    try {
      await save(value);
      if (!active.current) return;
      await onSessionChanged();
      dispatch({ request, type: "saveFinished" });
    } catch (cause) {
      const message = errorMessage(
        cause,
        "Could not save your Finance setting.",
      );
      if (active.current) dispatch({ message, request, type: "saveFailed" });
    }
  }
  const shown = shownFinanceStart(state, saved);
  return (
    <>
      <label className="check">
        <input
          aria-checked={shown}
          checked={shown}
          disabled={state.status === "saving"}
          onChange={(event) => void change(event.target.checked)}
          role="switch"
          type="checkbox"
        />
        {label}
      </label>
      {state.status === "failed" && (
        <Toast tone="danger">{state.message}</Toast>
      )}
    </>
  );
}
