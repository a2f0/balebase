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
 * Whether the sidebar's Finance opens on uncategorized expenses rather than
 * every transaction. Saved to the account, so it follows the person to every
 * device; the switch shows the new choice while it saves.
 */
export function FinanceStartSetting({
  on,
  onSessionChanged,
}: {
  on: boolean;
  /** Reloads the session, which carries the saved choice. */
  onSessionChanged: () => Promise<unknown>;
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
      await api.accountSettings.updateFinanceStart(value);
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
  const shown = shownFinanceStart(state, on);
  return (
    <>
      <Card
        description="Choose what opens when you select Finance in the sidebar."
        title="Finance"
      >
        <label className="check">
          <input
            aria-checked={shown}
            checked={shown}
            disabled={state.status === "saving"}
            onChange={(event) => void change(event.target.checked)}
            role="switch"
            type="checkbox"
          />
          Open Finance on uncategorized expenses
        </label>
      </Card>
      {state.status === "failed" && (
        <Toast tone="danger">{state.message}</Toast>
      )}
    </>
  );
}
