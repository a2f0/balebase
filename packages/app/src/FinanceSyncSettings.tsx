import { Banner, Card, PageSection } from "@balebase/ui/react";
import { useEffect, useState } from "react";
import { api } from "./apiClient";

/** Plaid's cursor belongs to the connection, so all of its accounts share this setting. */
export function FinanceSyncSettings({
  id,
  dailySync,
  status,
}: {
  id: string;
  dailySync: boolean;
  status: string;
}) {
  const [enabled, setEnabled] = useState(dailySync);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setEnabled(dailySync);
  }, [dailySync]);
  async function save(next: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.finance.updateSyncSettings(id, next);
      setEnabled(result.dailySync);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save sync settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageSection
      title="Automatic sync"
      description="Sync all accounts on this bank connection once per day, even when the app is closed. Changes apply to future runs; a sync already queued will finish."
    >
      <Card>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || !["active", "error"].includes(status)}
            onChange={(event) => void save(event.currentTarget.checked)}
          />
          Daily sync
        </label>
        {error && <Banner tone="danger">{error}</Banner>}
      </Card>
    </PageSection>
  );
}
