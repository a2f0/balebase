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
  useSectionTabs,
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
import { ActivityFeed } from "../activity/ActivityFeed";
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { countLabel, formatDateTime, formatLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { financeAccountPath } from "../workspace/workspacePaths";
import { connectionTone } from "./FinanceAccounts";
import { FinanceInstitutionHealth } from "./FinanceInstitutionHealth";
import { FinanceSourceFields, type SourceField } from "./FinanceSourceFields";
import { FinanceSyncSettings } from "./FinanceSyncSettings";
import {
  confirmDataDeletion,
  confirmDisconnect,
  syncNotice,
  syncPending,
  syncPollMs,
} from "./financeConnectionActions";
import { formatImportedHistory, formatMoney } from "./financeFormat";
import type { CacheScope } from "./transactionCache";
import { useGuardedLoad } from "./useCacheScope";

type Connection = FinanceConnectionDetail["connection"];

export function FinanceConnectionPage({
  id,
  onNavigate,
  scope,
}: {
  id: string;
  onNavigate: (path: string) => void;
  /** Whose saved transactions a refusal here clears. */
  scope?: CacheScope | undefined;
}) {
  const { actions, busy, data, error, guard, notice, setData } = useConnection(
    id,
    onNavigate,
    scope,
  );
  const sections = useConnectionSections();
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
        tabs={data && sections.tabs}
        tabsKind="panels"
        tabsLabel="Connection sections"
        title={data?.connection.institutionName ?? "Connection"}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {!data && !error && <LoadingState label="Loading connection…" />}
        {data && (
          <ConnectionSections
            data={data}
            guard={guard}
            id={id}
            onNavigate={onNavigate}
            panel={sections.panel}
            setData={setData}
          />
        )}
      </PageBody>
    </Page>
  );
}

/** A connection's overview, accounts, source data, and history tabs. */
function useConnectionSections() {
  return useSectionTabs([
    { id: "overview", label: "Overview" },
    { id: "accounts", label: "Accounts" },
    { id: "source", label: "Source data" },
    { id: "activity", label: "Activity" },
  ] as const);
}

function ConnectionSections({
  data,
  guard,
  id,
  onNavigate,
  panel,
  setData,
}: {
  data: FinanceConnectionDetail;
  guard: <T>(work: Promise<T>) => Promise<T>;
  id: string;
  onNavigate: (path: string) => void;
  panel: ReturnType<typeof useConnectionSections>["panel"];
  setData: Dispatch<SetStateAction<FinanceConnectionDetail | undefined>>;
}) {
  return (
    <>
      {panel(
        "overview",
        <>
          <ConnectionSummary connection={data.connection} />
          <FinanceInstitutionHealth
            // A new connection starts with no answer from the last one.
            key={data.connection.id}
            connection={data.connection}
            onNavigate={onNavigate}
          />
          <FinanceSyncSettings
            id={id}
            dailySync={data.connection.dailySync}
            guard={guard}
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
        </>,
      )}
      {panel(
        "accounts",
        <ConnectionAccounts accounts={data.accounts} onNavigate={onNavigate} />,
      )}
      {panel(
        "source",
        <PageSection
          description="Identifiers as Plaid reports them. Plaid support asks for the Item ID."
          title="Source data"
        >
          <FinanceSourceFields fields={sourceFields(data)} />
        </PageSection>,
      )}
      {panel(
        "activity",
        <ActivityFeed
          // Changes that record activity, not every sync status poll.
          refreshKey={`${data.connection.status}:${data.connection.dailySync}:${data.connection.syncJob?.id}`}
          source={{ id, type: "finance_connection" }}
        />,
      )}
    </>
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
          <dt>Last failed sync</dt>
          <dd>
            {connection.lastFailedSyncAt
              ? formatDateTime(connection.lastFailedSyncAt)
              : "None recorded"}
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
                  <AppLink
                    className="rowTitle rowTarget"
                    href={financeAccountPath(account.id)}
                    onNavigate={onNavigate}
                  >
                    {account.name}
                  </AppLink>
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

function useConnection(
  id: string,
  onNavigate: (path: string) => void,
  givenScope: CacheScope | undefined,
) {
  const loaded = useGuardedLoad(
    givenScope,
    useCallback(() => api.finance.connection(id), [id]),
    "Could not load connection.",
  );
  const { data, guard, reload, setData } = loaded;
  const pollError = useSyncStatusPolling(
    id,
    syncPending(data?.connection.syncJob?.status),
    setData,
    reload,
    guard,
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
        await guard(api.finance.deleteConnectionData(id));
        onNavigate("/finance/connections");
      });
    },
    disconnect: async () => {
      if (!data || !(await confirmDisconnect(data.connection))) return;
      await run(async () => {
        await guard(api.finance.disconnectConnection(id));
        return "Bank disconnected. Imported history was retained.";
      });
    },
    sync: () =>
      run(async () => syncNotice(await guard(api.finance.startSync(id)))),
  };
  return {
    actions,
    busy: action.busy || loaded.loading,
    data,
    error: action.error ?? pollError ?? loaded.error,
    guard,
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
  guard: <T>(work: Promise<T>) => Promise<T>,
) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await guard(api.finance.syncStatus(id));
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
      if (active) timer = setTimeout(() => void poll(), syncPollMs);
    }
    timer = setTimeout(() => void poll(), syncPollMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [guard, id, pending, reload, setData]);
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
