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
import type {
  FinanceAccount,
  FinanceConnection,
} from "@balebase/validators/finance";
import { syncPending } from "./financeConnectionActions";
import { formatMoney } from "./financeFormat";
import { financeConnectionPath } from "./financePages";
import { countLabel, formatLabel } from "./labels";
import { handleNavigation } from "./workspacePaths";

interface ConnectionHandlers {
  busy: boolean;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onNavigate: (pathname: string) => void;
  onSync: (id: string) => Promise<void>;
}

export function FinanceConnections({
  connections,
  loadError,
  onReload,
  ...handlers
}: ConnectionHandlers & {
  connections: FinanceConnection[] | undefined;
  loadError: string | undefined;
  onReload: () => Promise<void>;
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
      description="Sync each institution, disconnect it, or delete the data it imported. Select one for its accounts and Plaid identifiers."
      title="Connections"
    >
      {loadError && (
        <Banner
          actions={
            <Button onClick={() => void onReload()} size="sm">
              Retry
            </Button>
          }
          tone="danger"
        >
          {loadError}
        </Banner>
      )}
      {(!loadError || connections) && (
        <ConnectionList connections={connections} {...handlers} />
      )}
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
  const path = financeConnectionPath(connection.id);
  return (
    <li className="row rowInteractive financeConnection">
      <Avatar className="financeInstitutionMark" name={name} size="lg" />
      <div className="rowMain financeConnectionMain">
        <a
          className="rowTitle rowTarget financeConnectionName"
          href={path}
          onClick={(event) =>
            handleNavigation(event, path, handlers.onNavigate)
          }
        >
          {name}
        </a>
        <span className="rowMeta financeConnectionMeta">
          {countLabel(connection.accountCount, "account")} ·{" "}
          {syncTime(connection)}
          {connection.dailySync && " · Daily sync"}
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
        {formatLabel(
          syncPending(connection.syncStatus)
            ? (connection.syncStatus ?? connection.status)
            : connection.status,
        )}
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
          disabled={busy || syncPending(connection.syncStatus)}
          icon="refresh"
          onClick={() => void onConnect()}
          size="sm"
        >
          Reconnect
        </Button>
        <Button
          disabled={busy || syncPending(connection.syncStatus)}
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
        disabled={
          busy ||
          connection.status === "disconnecting" ||
          syncPending(connection.syncStatus)
        }
        icon="refresh"
        onClick={() => void onSync(connection.id)}
        size="sm"
      >
        {syncPending(connection.syncStatus) ? "Syncing…" : "Sync now"}
      </Button>
      <Button
        disabled={busy}
        icon="unlink"
        onClick={() => void onDisconnect(connection)}
        size="sm"
        variant="ghost"
      >
        {connection.status === "disconnecting"
          ? "Retry disconnect"
          : "Disconnect"}
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
        <span className="financeAccountMeta">
          <span className="financeAccountDetails" title={details}>
            {details}
          </span>
          {account.mask && (
            <span className="financeAccountMask">
              ·&nbsp;••••&nbsp;{account.mask}
            </span>
          )}
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

export function connectionTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "error") return "danger";
  return "neutral";
}
