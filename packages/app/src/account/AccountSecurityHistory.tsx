import { Card, LoadingState, Toast } from "@balebase/ui/react";
import type { SecurityEventAction } from "@balebase/validators/accountSettings";
import { useEffect, useRef } from "react";
import { api } from "../shared/apiClient";
import { useLoad } from "../shared/useLoad";

const loadEvents = async () =>
  (await api.accountSettings.securityEvents()).events;

const actionLabels: Record<SecurityEventAction, string> = {
  image_changed: "Profile picture changed",
  name_changed: "Name changed",
  password_changed: "Password changed",
  two_factor_authenticator_replaced: "Authenticator app replaced",
  two_factor_backup_codes_regenerated: "Backup codes regenerated",
  two_factor_disabled: "Two-factor authentication turned off",
  two_factor_enabled: "Two-factor authentication turned on",
};

type SecurityEvent = NonNullable<
  Awaited<ReturnType<typeof loadEvents>>
>[number];

function eventLabel({ action, change }: SecurityEvent) {
  // An app older than the API may meet an action it does not know.
  const label = actionLabels[action] ?? "Account changed";
  return change
    ? `${label} from "${change.before}" to "${change.after}"`
    : label;
}

/**
 * The person's own recent sign-in security and profile changes. It refreshes
 * when the two-factor setting changes, keeping the current list on screen.
 */
export function AccountSecurityHistory({
  twoFactorEnabled,
}: {
  twoFactorEnabled: boolean;
}) {
  const { data, error, reload } = useLoad(
    loadEvents,
    "Could not load security history.",
  );
  const shown = useRef(twoFactorEnabled);
  useEffect(() => {
    if (shown.current === twoFactorEnabled) return;
    shown.current = twoFactorEnabled;
    void reload();
  }, [reload, twoFactorEnabled]);
  return (
    <Card
      title="Security history"
      description="Your latest two-factor, password, and profile changes."
    >
      {error && <Toast tone="danger">{error}</Toast>}
      {!data && !error && <LoadingState label="Loading security history…" />}
      {data && data.length === 0 && (
        <p>No changes recorded yet. Earlier changes were not recorded.</p>
      )}
      {data && data.length > 0 && (
        <ul className="stack stackSm">
          {data.map((event) => (
            <li key={`${event.occurredAt}-${event.action}`}>
              {eventLabel(event)} ·{" "}
              {new Date(event.occurredAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
