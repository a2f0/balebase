import { Banner, Card, PageSection } from "@balebase/ui/react";
import { api } from "./shared/apiClient";
import { useAction } from "./shared/useAction";

/** Plaid's cursor belongs to the connection, so all of its accounts share this setting. */
export function FinanceSyncSettings({
  id,
  dailySync,
  onSaved,
  status,
}: {
  id: string;
  dailySync: boolean;
  onSaved: (dailySync: boolean) => void;
  status: string;
}) {
  const { busy, error, run } = useAction("Could not save sync settings.");
  const save = (next: boolean) =>
    run(async () =>
      onSaved((await api.finance.updateSyncSettings(id, next)).dailySync),
    );
  return (
    <PageSection
      title="Automatic sync"
      description="Sync all accounts on this bank connection once per day, even when the app is closed. Changes apply to future runs; a sync already queued will finish."
    >
      <Card>
        <label className="check">
          <input
            type="checkbox"
            checked={dailySync}
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
