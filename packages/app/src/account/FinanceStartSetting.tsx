import { Card, Toast } from "@balebase/ui/react";
import { useState } from "react";
import { api } from "../shared/apiClient";
import { useAction } from "../shared/useAction";

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
  const [pending, setPending] = useState<boolean>();
  const { busy, error, run } = useAction(
    "Could not save your Finance setting.",
  );
  const shown = pending ?? on;
  async function change(next: boolean) {
    setPending(next);
    await run(async () => {
      await api.accountSettings.updateFinanceStart(next);
      await onSessionChanged();
    });
    setPending(undefined);
  }
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
            disabled={busy}
            onChange={(event) => void change(event.target.checked)}
            role="switch"
            type="checkbox"
          />
          Open Finance on uncategorized expenses
        </label>
      </Card>
      {error && <Toast tone="danger">{error}</Toast>}
    </>
  );
}
