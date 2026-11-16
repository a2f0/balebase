import { Card, Field, Select, Toast } from "@balebase/ui/react";
import {
  type FinancePeriod,
  financePeriods,
} from "@balebase/validators/accountSettings";
import { useEffect, useReducer, useRef } from "react";
import { financePeriodLabels, financePeriodOf } from "../finance/financePeriod";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import {
  financeStartTransition,
  initialFinanceStart,
  shownFinanceStart,
} from "./financeStartState";

/**
 * Where Finance starts: the sidebar's Finance can open on uncategorized
 * expenses rather than every transaction, its transactions grouped by payee
 * rather than as a list, and on a period: the current or previous calendar
 * year, or all time. They combine. Each is saved to the account, so it
 * follows the person to every device.
 */
export function FinanceStartSetting({
  opensByPayee,
  opensPeriod,
  opensUncategorized,
  onSessionChanged,
}: {
  opensByPayee: boolean;
  opensPeriod: FinancePeriod;
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
          label="Open Finance on transactions grouped by payee"
          onSessionChanged={onSessionChanged}
          save={(value) => api.accountSettings.updateFinanceView(value)}
          saved={opensByPayee}
        />
        <PeriodSetting
          onSessionChanged={onSessionChanged}
          saved={opensPeriod}
        />
      </div>
    </Card>
  );
}

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
  const setting = useSettingSave(save, saved, onSessionChanged);
  return (
    <>
      <label className="check">
        <input
          aria-checked={setting.shown}
          checked={setting.shown}
          disabled={setting.saving}
          onChange={(event) => void setting.change(event.target.checked)}
          role="switch"
          type="checkbox"
        />
        {label}
      </label>
      {setting.failure && <Toast tone="danger">{setting.failure}</Toast>}
    </>
  );
}

/** The period Finance's transactions open on, chosen from a list. */
function PeriodSetting({
  onSessionChanged,
  saved,
}: {
  onSessionChanged: () => Promise<unknown>;
  saved: FinancePeriod;
}) {
  const setting = useSettingSave(
    (period: FinancePeriod) => api.accountSettings.updateFinancePeriod(period),
    saved,
    onSessionChanged,
  );
  return (
    <>
      <Field label="Open Finance on transactions from">
        <Select
          disabled={setting.saving}
          onChange={(event) =>
            void setting.change(financePeriodOf(event.target.value))
          }
          value={setting.shown}
        >
          {financePeriods.map((period) => (
            <option key={period} value={period}>
              {financePeriodLabels[period]}
            </option>
          ))}
        </Select>
      </Field>
      {setting.failure && <Toast tone="danger">{setting.failure}</Toast>}
    </>
  );
}

/**
 * One account choice's save. It shows the saved choice, or the choice being
 * saved while it saves, through its own save machine (`financeStartState.ts`),
 * so the choices save independently.
 */
function useSettingSave<Value>(
  save: (value: Value) => Promise<unknown>,
  saved: Value,
  onSessionChanged: () => Promise<unknown>,
) {
  const [state, dispatch] = useReducer(
    financeStartTransition<Value>,
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
  async function change(value: Value) {
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
  return {
    change,
    failure: state.status === "failed" ? state.message : undefined,
    saving: state.status === "saving",
    shown: shownFinanceStart(state, saved),
  };
}
