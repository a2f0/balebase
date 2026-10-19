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
import { useEffect, useState } from "react";
import { connectionTone } from "./FinanceAccounts";
import { FinanceSourceFields, type SourceField } from "./FinanceSourceFields";
import {
  deleteFinanceConnectionData,
  disconnectFinanceConnection,
  type FinanceConnectionAccount,
  type FinanceConnectionDetail,
  getFinanceConnection,
  syncFinanceConnection,
} from "./financeApi";
import {
  confirmDataDeletion,
  confirmDisconnect,
  syncNotice,
} from "./financeConnectionActions";
import {
  formatDateTime,
  formatImportedHistory,
  formatMoney,
} from "./financeFormat";
import { financeAccountPath } from "./financePages";
import { countLabel, formatLabel } from "./labels";
import { handleNavigation } from "./workspacePaths";

type Connection = FinanceConnectionDetail["connection"];

export function FinanceConnectionPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (path: string) => void;
}) {
  const { actions, busy, data, error, notice } = useConnection(id, onNavigate);
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
        disabled={busy}
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
        disabled={busy}
        icon="refresh"
        onClick={() => void sync()}
      >
        Sync now
      </Button>
      <Button
        disabled={busy}
        icon="unlink"
        onClick={() => void disconnect()}
        variant="ghost"
      >
        Disconnect
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
  const [data, setData] = useState<FinanceConnectionDetail>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void getFinanceConnection(id)
      .then((next) => {
        if (active) setData(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [id]);
  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setNotice(await action());
    } catch (cause) {
      setError(message(cause));
    }
    // A failed sync records the connection's error, so reload either way.
    try {
      setData(await getFinanceConnection(id));
    } catch (cause) {
      setError((current) => current ?? message(cause));
    }
    setBusy(false);
  }
  const actions = {
    deleteData: async () => {
      if (!data || !(await confirmDataDeletion(data.connection))) return;
      setBusy(true);
      setError(undefined);
      try {
        await deleteFinanceConnectionData(id);
        onNavigate("/finance/connections");
      } catch (cause) {
        setError(message(cause));
        setBusy(false);
      }
    },
    disconnect: async () => {
      if (!data || !(await confirmDisconnect(data.connection))) return;
      await run(async () => {
        await disconnectFinanceConnection(id);
        return "Bank disconnected. Imported history was retained.";
      });
    },
    sync: () => run(async () => syncNotice(await syncFinanceConnection(id))),
  };
  return { actions, busy, data, error, notice };
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

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load connection.";
}
