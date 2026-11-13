import { Banner, Button, Card, LoadingState, Toast } from "@balebase/ui/react";
import { paidFeatures } from "@balebase/validators/rules";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../shared/apiClient";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";

/** The parent keys this card by organization so requests cannot cross workspaces. */
export function OrganizationPaidFeatures({
  canManage,
  onAccessChanged,
}: {
  canManage: boolean;
  onAccessChanged: () => Promise<void>;
}) {
  const loaded = useLoad(
    useCallback(() => api.organizationSettings.current(), []),
    "Could not load paid features.",
  );
  const action = useAction("Could not update paid features.");
  const active = useRef(true);
  const saving = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function change(paidFeaturesEnabled: boolean) {
    if (!canManage || saving.current || loaded.loading || !loaded.data) return;
    saving.current = true;
    await action.run(async () => {
      const settings = await api.organizationSettings.updateCurrent({
        paidFeaturesEnabled,
      });
      if (!active.current) return;
      loaded.setData(settings);
      await onAccessChanged();
    });
    saving.current = false;
  }
  return (
    <Card
      title="Paid features"
      description={Object.values(paidFeatures).join(" and ")}
    >
      <p>
        Allow paid features for this organization. Turning this off does not
        cancel subscriptions, change billing, or erase existing data.
      </p>
      {loaded.loading && <LoadingState label="Loading paid features…" />}
      {loaded.error && (
        <Banner
          tone="danger"
          actions={<Button onClick={() => void loaded.reload()}>Retry</Button>}
        >
          {loaded.error}
        </Banner>
      )}
      <label className="check">
        <input
          aria-checked={loaded.data?.paidFeaturesEnabled ?? false}
          checked={loaded.data?.paidFeaturesEnabled ?? false}
          disabled={
            !canManage ||
            loaded.loading ||
            !loaded.data ||
            Boolean(loaded.error) ||
            action.busy
          }
          onChange={(event) => void change(event.target.checked)}
          role="switch"
          type="checkbox"
        />
        Enable paid features
      </label>
      {!canManage && (
        <p className="muted">
          Only organization owners and admins can change this setting.
        </p>
      )}
      {action.error && <Toast tone="danger">{action.error}</Toast>}
    </Card>
  );
}
