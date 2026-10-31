import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  PageSection,
} from "@balebase/ui/react";
import type {
  FinanceConnectionDetail,
  FinanceInstitutionHealth as Health,
  InstitutionProductHealth,
} from "@balebase/validators/finance";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { formatDateTime, formatLabel } from "../shared/labels";

type Connection = FinanceConnectionDetail["connection"];

/**
 * Lets anyone with the connection check whether its bank has a wider outage,
 * from Plaid's live health across all its users. It checks by itself when the
 * connection is in error, since that is when someone is deciding whether to
 * retry Update login.
 */
export function FinanceInstitutionHealth({
  connection,
  onNavigate,
}: {
  connection: Connection;
  onNavigate: (path: string) => void;
}) {
  const bank = connection.institutionName ?? "this bank";
  const { busy, check, error, health } = useInstitutionHealth(
    connection.id,
    connection.status === "error",
  );
  if (connection.status === "disconnected") return null;
  return (
    <PageSection
      actions={
        <Button
          busy={busy}
          disabled={busy}
          icon="refresh"
          onClick={() => void check()}
        >
          {health ? "Check again" : "Check for outages"}
        </Button>
      }
      description={`Plaid's live status for ${bank} across everyone who connects it, not only this connection.`}
      title="Bank status"
    >
      {error && <Banner tone="danger">{error}</Banner>}
      {health ? (
        <>
          <HealthGuidance
            bank={bank}
            connectionStatus={connection.status}
            health={health}
            onNavigate={onNavigate}
          />
          <Card>
            <dl className="keyValue">
              <dt>Logins and repairs</dt>
              <dd>
                <ProductHealth health={health.logins} />
              </dd>
              <dt>Transaction updates</dt>
              <dd>
                <ProductHealth health={health.transactions} />
                {health.transactions?.refreshInterval &&
                  health.transactions.refreshInterval !== "NORMAL" &&
                  ` · Refreshes ${formatLabel(health.transactions.refreshInterval).toLowerCase()}`}
              </dd>
              <dt>Checked</dt>
              <dd>{formatDateTime(health.checkedAt)}</dd>
            </dl>
          </Card>
        </>
      ) : (
        !busy &&
        !error && (
          <Card>
            <p>
              If syncing or Update login keeps failing, check whether {bank} is
              having a wider outage before trying again.
            </p>
          </Card>
        )
      )}
    </PageSection>
  );
}

function useInstitutionHealth(id: string, checkNow: boolean) {
  const [health, setHealth] = useState<Health>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const check = useCallback(async () => {
    const request = ++latest.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.finance.institutionHealth(id);
      if (request === latest.current) setHealth(next);
    } catch (cause) {
      if (request === latest.current)
        setError(errorMessage(cause, "Could not check the bank's status."));
    } finally {
      if (request === latest.current) setBusy(false);
    }
  }, [id]);
  // A check still running when the page closes must not update it.
  useEffect(
    () => () => {
      latest.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (checkNow) void check();
  }, [check, checkNow]);
  return { busy, check, error, health };
}

function ProductHealth({
  health,
}: {
  health: InstitutionProductHealth | null;
}) {
  const label = health?.status ? formatLabel(health.status) : "Unknown";
  const details = health ? healthDetails(health) : "Plaid did not report it.";
  return (
    <>
      <Badge dot tone={statusTone(health?.status ?? null)}>
        {label}
      </Badge>
      {details && ` ${details}`}
    </>
  );
}

function healthDetails(health: InstitutionProductHealth) {
  const parts: string[] = [];
  if (health.successRate !== null)
    parts.push(`${health.successRate}% of recent requests succeeded`);
  const failures = [
    health.institutionErrorRate !== null &&
      `${health.institutionErrorRate}% failed at the bank`,
    health.plaidErrorRate !== null &&
      `${health.plaidErrorRate}% failed at Plaid`,
  ].filter(Boolean);
  if (failures.length) parts.push(failures.join(", "));
  if (health.lastStatusChange)
    parts.push(`status since ${formatDateTime(health.lastStatusChange)}`);
  return parts.join(" · ");
}

function statusTone(status: string | null): BadgeTone {
  if (status === "HEALTHY") return "success";
  if (status === "DEGRADED") return "warning";
  if (status === "DOWN") return "danger";
  return "neutral";
}

const troubled = (health: { status: string | null } | null) =>
  health?.status === "DEGRADED" || health?.status === "DOWN";

/** What the reported health means for this connection, in Plaid's words. */
function HealthGuidance({
  bank,
  connectionStatus,
  health,
  onNavigate,
}: {
  bank: string;
  connectionStatus: string;
  health: Health;
  onNavigate: (path: string) => void;
}) {
  if (!health.institutionId) {
    return (
      <Banner>
        This connection has no Plaid institution ID, so its bank's status cannot
        be checked.
      </Banner>
    );
  }
  if (troubled(health.logins)) {
    return (
      <Banner tone="warning">
        Plaid reports that logins at {bank} are failing for many people. Wait
        before using Update login again; this connection and its history are
        kept while you wait.
      </Banner>
    );
  }
  if (troubled(health.transactions)) {
    return (
      <Banner tone="warning">
        Plaid reports problems refreshing transactions at {bank}, so new
        transactions may arrive late.
      </Banner>
    );
  }
  if (!health.logins?.status) {
    return (
      <Banner>
        Plaid did not report login status for {bank} right now. That does not
        mean it is working.
      </Banner>
    );
  }
  if (connectionStatus === "error" && health.logins.status === "HEALTHY") {
    return (
      <Banner>
        Plaid reports that logins at {bank} are working for most people, so this
        connection probably needs its own login updated. Use Update login on{" "}
        <AppLink href="/finance/connections" onNavigate={onNavigate}>
          Connections
        </AppLink>
        .
      </Banner>
    );
  }
  return null;
}
