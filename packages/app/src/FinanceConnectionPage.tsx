import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type {
  FinanceConnectionAccount,
  FinanceConnectionDetail,
} from "@balebase/validators/finance";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import { api } from "./apiClient";
import { errorMessage } from "./errors";
import { connectionTone } from "./FinanceAccounts";
import { FinanceSourceFields, type SourceField } from "./FinanceSourceFields";
import { FinanceSyncSettings } from "./FinanceSyncSettings";
import {
  confirmDataDeletion,
  confirmDisconnect,
  syncNotice,
  syncPending,
} from "./financeConnectionActions";
import { formatImportedHistory, formatMoney } from "./financeFormat";
import { countLabel, formatDateTime, formatLabel } from "./labels";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";
import { financeAccountPath, handleNavigation } from "./workspacePaths";

type Connection = FinanceConnectionDetail["connection"];

export function FinanceConnectionPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (path: string) => void;
}) {
  const { actions, busy, data, error, notice, setData } = useConnection(
    id,
    onNavigate,
  );
  return (
    <Page>
      <PageHeader
        actions={
          <>
            {data && (
              <ConnectionActions
                busy={busy}
                connection={data.connection}
                {...actions}
              />
            )}
            <Button onClick={() => onNavigate("/finance/connections")}>
              All connections
            </Button>
          </>
        }
        eyebrow="Finance connection"
        title={data?.connection.institutionName ?? "Connection"}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {!data && !error && <LoadingState label="Loading connection…" />}
        {data && (
          <>
            <ConnectionSummary connection={data.connection} />
            <FinanceSyncSettings
              id={id}
              dailySync={data.connection.dailySync}
              onSaved={(dailySync) =>
                setData(
                  (current) =>
                    current && {
                      ...current,
                      connection: { ...current.connection, dailySync },
                    },
                )
              }
              status={data.connection.status}
            />
            <ConnectionAccounts
              accounts={data.accounts}
              onNavigate={onNavigate}
            />
            <PageSection
              description="Identifiers as Plaid reports them. Plaid support asks for the Item ID."
              title="Source data"
            >
              <FinanceSourceFields fields={sourceFields(data)} />
            </PageSection>
          </>
        )}
      </PageBody>
    </Page>
  );
}

function ConnectionActions({
  busy,
  connection,
  deleteData,
  disconnect,
  sync,
}: ReturnType<typeof useConnection>["actions"] & {
  busy: boolean;
  connection: Connection;
}) {
  // Reconnecting runs Plaid Link, which lives on the Connections tab.
  if (connection.status === "disconnected") {
    return (
      <Button
        disabled={busy || syncPending(connection.syncJob?.status)}
        icon="trash"
        onClick={() => void deleteData()}
        variant="danger"
      >
        Delete data
      </Button>
    );
  }
  return (
    <>
      <Button
        busy={busy}
        disabled={
          busy ||
          connection.status === "disconnecting" ||
          syncPending(connection.syncJob?.status)
        }
        icon="refresh"
        onClick={() => void sync()}
      >
        {syncPending(connection.syncJob?.status) ? "Syncing…" : "Sync now"}
      </Button>
      <Button
        disabled={busy}
        icon="unlink"
        onClick={() => void disconnect()}
        variant="ghost"
      >
        {connection.status === "disconnecting"
          ? "Retry disconnect"
          : "Disconnect"}
      </Button>
    </>
  );
}

function ConnectionSummary({ connection }: { connection: Connection }) {
  return (
    <PageSection title="Connection">
      <Card>
        <dl className="keyValue">
          <dt>Status</dt>
          <dd>
            <Badge dot tone={connectionTone(connection.status)}>
              {formatLabel(connection.status)}
            </Badge>
          </dd>
          {connection.errorCode && (
            <>
              <dt>Last error</dt>
              <dd>
                <span className="mono">{connection.errorCode}</span>
                {connection.errorMessage && ` · ${connection.errorMessage}`}
              </dd>
            </>
          )}
          <dt>Latest sync</dt>
          <dd role="status">
            {connection.syncJob
              ? formatLabel(connection.syncJob.status)
              : "Not started"}
            {syncPending(connection.syncJob?.status) &&
              " · You can leave this page; syncing continues in the background."}
            {connection.syncJob?.status === "succeeded" &&
              ` · ${connection.syncJob.added} added, ${connection.syncJob.modified} updated, ${connection.syncJob.removed} removed`}
          </dd>
          <dt>Connected</dt>
          <dd>
            {formatDateTime(connection.createdAt)}
            {connection.createdBy &&
              ` by ${connection.createdBy.name || connection.createdBy.email}`}
          </dd>
          <dt>Last synced</dt>
          <dd>
            {connection.lastSyncedAt
              ? formatDateTime(connection.lastSyncedAt)
              : "Not synced yet"}
          </dd>
          {connection.disconnectedAt && (
            <>
              <dt>Disconnected</dt>
              <dd>{formatDateTime(connection.disconnectedAt)}</dd>
            </>
          )}
          <dt>Imported history</dt>
          <dd>{formatImportedHistory(connection.transactions)}</dd>
        </dl>
      </Card>
    </PageSection>
  );
}

function ConnectionAccounts({
  accounts,
  onNavigate,
}: {
  accounts: FinanceConnectionAccount[];
  onNavigate: (path: string) => void;
}) {
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(accounts.length, "account")}
        </span>
      }
      title="Accounts"
    >
      {accounts.length ? (
        <Card className="financeListCard" flush>
          <ul className="rowList">
            {accounts.map((account) => (
              <li className="row rowInteractive" key={account.id}>
                <div className="rowMain">
                  <a
                    className="rowTitle rowTarget"
                    href={financeAccountPath(account.id)}
                    onClick={(event) =>
                      handleNavigation(
                        event,
                        financeAccountPath(account.id),
                        onNavigate,
                      )
                    }
                  >
                    {account.name}
                  </a>
                  <span className="rowMeta">{accountMeta(account)}</span>
                </div>
                <span className="financeAmount">
                  {formatMoney(account.currentBalance, account.currencyCode)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState icon="finance" title="No accounts imported yet">
          Sync the connection to import its accounts.
        </EmptyState>
      )}
    </PageSection>
  );
}

function useConnection(id: string, onNavigate: (path: string) => void) {
  const loaded = useLoad(
    useCallback(() => api.finance.connection(id), [id]),
    "Could not load connection.",
  );
  const { data, reload, setData } = loaded;
  const pollError = useSyncStatusPolling(
    id,
    syncPending(data?.connection.syncJob?.status),
    setData,
    reload,
  );
  const action = useAction("Could not update the connection.");
  async function run(work: () => Promise<string>) {
    await action.run(work, (notice) => notice);
    // A failed sync records the connection's error, so reload either way.
    await reload();
  }
  const actions = {
    deleteData: async () => {
      if (!data || !(await confirmDataDeletion(data.connection))) return;
      await action.run(async () => {
        await api.finance.deleteConnectionData(id);
        onNavigate("/finance/connections");
      });
    },
    disconnect: async () => {
      if (!data || !(await confirmDisconnect(data.connection))) return;
      await run(async () => {
        await api.finance.disconnectConnection(id);
        return "Bank disconnected. Imported history was retained.";
      });
    },
    sync: () => run(async () => syncNotice(await api.finance.startSync(id))),
  };
  return {
    actions,
    busy: action.busy || loaded.loading,
    data,
    error: action.error ?? pollError ?? loaded.error,
    notice: action.notice,
    setData,
  };
}

/** Polls a running sync; balances and history reload once it finishes. */
function useSyncStatusPolling(
  id: string,
  pending: boolean,
  setData: Dispatch<SetStateAction<FinanceConnectionDetail | undefined>>,
  reload: () => Promise<unknown>,
) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await api.finance.syncStatus(id);
        if (!active) return;
        setError(undefined);
        if (syncPending(next.connection.syncJob?.status)) {
          setData(
            (current) =>
              current && {
                ...current,
                connection: { ...current.connection, ...next.connection },
              },
          );
        } else {
          await reload();
        }
      } catch (cause) {
        if (active) setError(errorMessage(cause, "Could not load connection."));
      }
      if (active) timer = setTimeout(() => void poll(), 3000);
    }
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, pending, reload, setData]);
  return error;
}

function sourceFields({
  accounts,
  connection,
}: FinanceConnectionDetail): SourceField[] {
  return [
    { label: "Institution", value: connection.institutionName },
    {
      copyable: true,
      label: "Plaid institution ID",
      value: connection.institutionId,
    },
    { copyable: true, label: "Plaid Item ID", value: connection.plaidItemId },
    ...accounts.map((account) => ({
      copyable: true,
      label: `Plaid account ID · ${account.name}${account.mask ? ` ••${account.mask}` : ""}`,
      value: account.plaidAccountId,
    })),
    { copyable: true, label: "Balebase ID", value: connection.id },
  ];
}

function accountMeta(account: FinanceConnectionAccount) {
  return [
    account.officialName,
    formatLabel(account.subtype ?? account.type),
    account.mask && `•••• ${account.mask}`,
    countLabel(account.transactionCount, "transaction"),
  ]
    .filter(Boolean)
    .join(" · ");
}
