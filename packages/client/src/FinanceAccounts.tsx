import {
  Avatar,
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  cx,
  EmptyState,
  Icon,
  LoadingState,
  PageSection,
} from "@balebase/ui/react";
import type { FinanceAccount, FinanceConnection } from "./financeApi";
import { formatMoney } from "./financeFormat";
import { countLabel, formatLabel } from "./labels";

interface ConnectionHandlers {
  busy: boolean;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onSync: (id: string) => Promise<void>;
}

export function FinanceConnections({
  connections,
  ...handlers
}: ConnectionHandlers & {
  connections: FinanceConnection[] | undefined;
}) {
  return (
    <PageSection
      actions={
        connections?.length ? (
          <span className="sectionCount">
            {countLabel(connections.length, "institution")}
          </span>
        ) : undefined
      }
      description="Sync each institution, disconnect it, or delete the data it imported."
      title="Connections"
    >
      <ConnectionList connections={connections} {...handlers} />
    </PageSection>
  );
}

function ConnectionList({
  connections,
  ...handlers
}: ConnectionHandlers & {
  connections: FinanceConnection[] | undefined;
}) {
  if (!connections) return <LoadingState label="Loading connections…" />;
  if (!connections.length) {
    return (
      <EmptyState icon="link" title="No banks connected yet">
        Connect a bank to import its balances and transactions.
      </EmptyState>
    );
  }
  return (
    <Card className="financeListCard" flush>
      <ul className="rowList financeConnections">
        {connections.map((connection) => (
          <ConnectionRow
            connection={connection}
            key={connection.id}
            {...handlers}
          />
        ))}
      </ul>
    </Card>
  );
}

/**
 * Connections live on their own tab, so the overview only flags the ones
 * that stopped syncing and would otherwise leave balances quietly stale.
 */
export function FinanceConnectionAlert({
  connections,
  onNavigate,
}: {
  connections: FinanceConnection[] | undefined;
  onNavigate: (pathname: string) => void;
}) {
  const failing =
    connections?.filter((connection) => connection.status === "error") ?? [];
  const [first] = failing;
  if (!first) return null;
  return (
    <Banner
      actions={
        <Button onClick={() => onNavigate("/finance/connections")} size="sm">
          Review connections
        </Button>
      }
      announce={false}
      title={
        failing.length === 1
          ? `${first.institutionName ?? "A connection"} stopped syncing`
          : `${failing.length} connections stopped syncing`
      }
      tone="warning"
    >
      Balances and transactions may be out of date.
    </Banner>
  );
}

function ConnectionRow({
  connection,
  ...handlers
}: ConnectionHandlers & { connection: FinanceConnection }) {
  const name = connection.institutionName ?? "Financial institution";
  return (
    <li className="row financeConnection">
      <Avatar className="financeInstitutionMark" name={name} size="lg" />
      <div className="rowMain financeConnectionMain">
        <span className="rowTitle financeConnectionName">{name}</span>
        <span className="rowMeta financeConnectionMeta">
          {countLabel(connection.accountCount, "account")} ·{" "}
          {syncTime(connection)}
          {connection.status === "error" && connection.errorCode && (
            <>
              {" · "}
              <span className="mono">{connection.errorCode}</span>
            </>
          )}
        </span>
      </div>
      <Badge
        className="financeConnectionStatus"
        dot
        tone={connectionTone(connection.status)}
      >
        {formatLabel(connection.status)}
      </Badge>
      <ConnectionActions connection={connection} {...handlers} />
    </li>
  );
}

function ConnectionActions({
  busy,
  connection,
  onConnect,
  onDeleteData,
  onDisconnect,
  onSync,
}: ConnectionHandlers & { connection: FinanceConnection }) {
  if (connection.status === "disconnected") {
    return (
      <div className="rowActions financeConnectionActions">
        <Button
          disabled={busy}
          icon="refresh"
          onClick={() => void onConnect()}
          size="sm"
        >
          Reconnect
        </Button>
        <Button
          disabled={busy}
          icon="trash"
          onClick={() => void onDeleteData(connection)}
          size="sm"
          variant="danger"
        >
          Delete data
        </Button>
      </div>
    );
  }
  return (
    <div className="rowActions financeConnectionActions">
      <Button
        disabled={busy}
        icon="refresh"
        onClick={() => void onSync(connection.id)}
        size="sm"
      >
        Sync now
      </Button>
      <Button
        disabled={busy}
        icon="unlink"
        onClick={() => void onDisconnect(connection)}
        size="sm"
        variant="ghost"
      >
        Disconnect
      </Button>
    </div>
  );
}

export function FinanceAccounts({
  accounts,
  onSelect,
  selectedAccountIds,
}: {
  accounts: FinanceAccount[] | undefined;
  onSelect: (accountId: string, shiftKey: boolean) => void;
  selectedAccountIds: string[];
}) {
  if (!accounts?.length) return null;
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(accounts.length, "account")}
        </span>
      }
      description="Select accounts to filter transactions. Shift-click to select more than one."
      title="Accounts"
    >
      <div className="gridAuto financeAccountGrid">
        {accounts.map((account) => (
          <AccountCard
            account={account}
            key={account.id}
            onSelect={onSelect}
            selected={selectedAccountIds.includes(account.id)}
          />
        ))}
      </div>
    </PageSection>
  );
}

function AccountCard({
  account,
  onSelect,
  selected,
}: {
  account: FinanceAccount;
  onSelect: (accountId: string, shiftKey: boolean) => void;
  selected: boolean;
}) {
  const details = [
    account.institutionName,
    formatLabel(account.subtype ?? account.type),
    account.mask && `••••\u00a0${account.mask}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      aria-pressed={selected}
      className={cx(
        "card cardInteractive financeAccount",
        selected && "cardSelected",
      )}
      onClick={(event) => onSelect(account.id, event.shiftKey)}
      type="button"
    >
      <span className="financeAccountLine">
        <span className="financeAccountName" title={account.name}>
          {account.name}
        </span>
        <span className="financeAccountBalance">
          {formatMoney(account.currentBalance, account.currencyCode)}
        </span>
      </span>
      <span className="financeAccountLine">
        <span className="financeAccountMeta" title={details}>
          {details}
        </span>
        {selected && (
          <span className="financeAccountCheck">
            <Icon name="check" size={10} strokeWidth={3} />
          </span>
        )}
      </span>
    </button>
  );
}

function syncTime(connection: FinanceConnection) {
  return connection.lastSyncedAt
    ? `synced ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(connection.lastSyncedAt))}`
    : "not synced yet";
}

function connectionTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "error") return "danger";
  return "neutral";
}
