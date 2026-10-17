import {
  Banner,
  Button,
  ButtonLink,
  confirmDialog,
  Page,
  PageBody,
  PageHeader,
  Toast,
} from "@balebase/ui/react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { websiteUrl } from "./config";
import { FinanceAccounts, FinanceConnections } from "./FinanceAccounts";
import { FinanceCategories } from "./FinanceCategories";
import { FinanceReports } from "./FinanceReports";
import { FinanceTransactionHistory } from "./FinanceTransactionHistory";
import {
  createPlaidLinkToken,
  deleteFinanceConnectionData,
  disconnectFinanceConnection,
  exchangePlaidPublicToken,
  type FinanceConnection,
  type FinanceData,
  type FinanceTransaction,
  type FinanceTransactionAnnotationInput,
  setTransactionCategory,
  syncFinanceConnection,
  updateFinanceTransactionAnnotation,
} from "./financeApi";
import { type FinancePage, financePageFor, financePages } from "./financePages";
import { selectFinanceAccount } from "./financeTransactions";
import { type FinanceListingState, useFinanceData } from "./useFinanceData";
import { handleNavigation } from "./workspacePaths";

const linkTokenStorageKey = "balebase.plaid.linkToken";

export function Finance({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const { load, setData, ...listing } = useFinanceData();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const plaid = usePlaidConnect(load, setError, setNotice);
  const actions = financeActions(load, setWorking, setError, setNotice);
  const busy = working || plaid.busy;

  return (
    <FinanceView
      busy={busy}
      {...listing}
      error={error}
      notice={notice}
      onAnnotate={actions.annotate}
      onCategorize={categorizeTransaction(setData, setError)}
      onConnect={plaid.connect}
      onDeleteData={actions.deleteData}
      onDisconnect={actions.disconnect}
      onNavigate={onNavigate}
      onReload={load}
      onSync={actions.sync}
      page={financePageFor(pathname)}
    />
  );
}

/**
 * Assigns a transaction's single expense category right away, updating the
 * list and category counts optimistically and restoring them on failure.
 */
function categorizeTransaction(
  setData: Dispatch<SetStateAction<FinanceData | undefined>>,
  setError: Dispatch<SetStateAction<string | undefined>>,
) {
  return async (transaction: FinanceTransaction, categoryId: string | null) => {
    const previous = transaction.expenseCategoryId;
    if (previous === categoryId) return;
    setError(undefined);
    setData((current) =>
      withCategory(current, transaction.id, previous, categoryId),
    );
    try {
      await setTransactionCategory(transaction.id, categoryId);
    } catch (cause) {
      setData((current) =>
        withCategory(current, transaction.id, categoryId, previous),
      );
      setError(messageFrom(cause));
    }
  };
}

function withCategory(
  data: FinanceData | undefined,
  transactionId: string,
  from: string | null,
  to: string | null,
): FinanceData | undefined {
  if (!data) return data;
  return {
    ...data,
    categories: data.categories.map((category) => {
      const change =
        (category.id === to ? 1 : 0) - (category.id === from ? 1 : 0);
      return change
        ? { ...category, transactionCount: category.transactionCount + change }
        : category;
    }),
    transactions: data.transactions.map((transaction) =>
      transaction.id === transactionId
        ? { ...transaction, expenseCategoryId: to }
        : transaction,
    ),
  };
}

function financeActions(
  load: () => Promise<void>,
  setWorking: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | undefined>>,
  setNotice: Dispatch<SetStateAction<string | undefined>>,
) {
  async function run(action: () => Promise<string>) {
    setWorking(true);
    setError(undefined);
    try {
      setNotice(await action());
      await load();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setWorking(false);
    }
  }
  return {
    annotate: (
      transaction: FinanceTransaction,
      input: FinanceTransactionAnnotationInput,
    ) =>
      run(async () => {
        await updateFinanceTransactionAnnotation(transaction.id, input);
        return "Transaction annotation saved.";
      }),
    deleteData: async (connection: FinanceConnection) => {
      if (await confirmDataDeletion(connection)) {
        await run(async () => {
          await deleteFinanceConnectionData(connection.id);
          return "Imported bank data permanently deleted.";
        });
      }
    },
    disconnect: async (connection: FinanceConnection) => {
      if (await confirmDisconnect(connection)) {
        await run(async () => {
          await disconnectFinanceConnection(connection.id);
          return "Bank disconnected. Imported history was retained.";
        });
      }
    },
    sync: (id: string) =>
      run(async () => syncNotice(await syncFinanceConnection(id))),
  };
}

const setupNoticeId = "finance-setup-notice";

interface OverviewHandlers {
  busy: boolean;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotationInput,
  ) => Promise<void>;
  onCategorize: (
    transaction: FinanceTransaction,
    categoryId: string | null,
  ) => Promise<void>;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onNavigate: (pathname: string) => void;
  onSync: (id: string) => Promise<void>;
}

export function FinanceView({
  data,
  error,
  notice,
  onReload,
  page,
  ...handlers
}: OverviewHandlers &
  FinanceListingState & {
    error: string | undefined;
    notice: string | undefined;
    onReload: () => Promise<void>;
    page: FinancePage;
  }) {
  const unconfigured = data?.configured === false;
  return (
    <Page>
      <FinanceHeader
        busy={handlers.busy}
        onConnect={handlers.onConnect}
        onNavigate={handlers.onNavigate}
        page={page}
        unconfigured={unconfigured}
      />
      <PageBody>
        <FinanceNotices
          error={
            error ?? (page === "overview" ? undefined : handlers.loadError)
          }
          notice={notice}
          overview={page === "overview"}
          showDataNotice={data?.accounts.length === 0}
          unconfigured={unconfigured}
        />
        {page === "reports" && (
          <FinanceReports onNavigate={handlers.onNavigate} />
        )}
        {page === "categories" && (
          <FinanceCategories
            categories={data?.categories}
            onChanged={onReload}
          />
        )}
        {page === "overview" && (
          <FinanceOverview data={data} onReload={onReload} {...handlers} />
        )}
      </PageBody>
    </Page>
  );
}

function FinanceOverview({
  data,
  filters,
  loading,
  loadingMore,
  refreshing,
  loadError,
  loadMoreError,
  onFiltersChange,
  onLoadMore,
  onReload,
  ...handlers
}: OverviewHandlers & FinanceListingState & { onReload: () => Promise<void> }) {
  const [selectedTransactionId, setSelectedTransactionId] = useState<string>();
  const selectedAccounts =
    data?.accounts.filter((account) =>
      filters.accountIds.includes(account.id),
    ) ?? [];
  const accountName =
    filters.accountIds.length === 1
      ? (selectedAccounts[0]?.name ?? "selected account")
      : filters.accountIds.length > 1
        ? `${filters.accountIds.length} accounts`
        : undefined;
  const transactions = loading
    ? undefined
    : data?.transactions.filter(
        (transaction) =>
          !filters.uncategorized || !transaction.expenseCategoryId,
      );
  return (
    <>
      <FinanceConnections
        busy={handlers.busy}
        connections={data?.connections}
        onConnect={handlers.onConnect}
        onDeleteData={handlers.onDeleteData}
        onDisconnect={handlers.onDisconnect}
        onSync={handlers.onSync}
      />
      <FinanceAccounts
        accounts={data?.accounts}
        onSelect={(accountId, shiftKey) =>
          onFiltersChange({
            ...filters,
            accountIds: selectFinanceAccount(
              filters.accountIds,
              accountId,
              shiftKey,
            ),
          })
        }
        selectedAccountIds={filters.accountIds}
      />
      <FinanceTransactionHistory
        accountName={accountName}
        filters={filters}
        onFiltersChange={onFiltersChange}
        hasMore={Boolean(data?.nextCursor)}
        loadingMore={loadingMore}
        loadError={loadError}
        loadMoreError={loadMoreError}
        onLoadMore={onLoadMore}
        onReload={onReload}
        busy={handlers.busy || refreshing || loadingMore}
        categories={data?.categories ?? []}
        onAnnotate={handlers.onAnnotate}
        onCategorize={handlers.onCategorize}
        onClearFilter={() => onFiltersChange({ ...filters, accountIds: [] })}
        onNavigate={handlers.onNavigate}
        onSelectAnnotation={(transactionId) =>
          setSelectedTransactionId((current) =>
            current === transactionId ? undefined : transactionId,
          )
        }
        selectedTransactionId={selectedTransactionId}
        transactions={transactions}
      />
    </>
  );
}

function FinanceHeader({
  busy,
  onConnect,
  onNavigate,
  page,
  unconfigured,
}: {
  busy: boolean;
  onConnect: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  page: FinancePage;
  unconfigured: boolean;
}) {
  return (
    <PageHeader
      actions={
        page === "overview" && (
          <Button
            aria-describedby={unconfigured ? setupNoticeId : undefined}
            busy={busy}
            disabled={unconfigured}
            icon="add"
            onClick={() => void onConnect()}
            variant="primary"
          >
            {busy ? "Working…" : "Connect bank"}
          </Button>
        )
      }
      description="Balances and transactions from your connected institutions, ready for your team to review, categorize, and report on."
      eyebrow="Connected accounts"
      tabs={financePages.map((item) => (
        <a
          aria-current={page === item.page ? "page" : undefined}
          className="tab"
          href={item.path}
          key={item.path}
          onClick={(event) => handleNavigation(event, item.path, onNavigate)}
        >
          {item.label}
        </a>
      ))}
      tabsLabel="Finance sections"
      title="Finance"
    />
  );
}

function FinanceNotices({
  error,
  notice,
  overview,
  showDataNotice,
  unconfigured,
}: {
  error: string | undefined;
  notice: string | undefined;
  /** Setup and data-handling notices belong with the connections. */
  overview: boolean;
  showDataNotice: boolean;
  unconfigured: boolean;
}) {
  return (
    <>
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {overview && (unconfigured || showDataNotice) && (
        <div className="stack stackMd">
          {unconfigured && <FinanceSetupNotice />}
          {showDataNotice && <FinanceDataNotice />}
        </div>
      )}
    </>
  );
}

function FinanceDataNotice() {
  return (
    <Banner
      announce={false}
      icon="lock"
      title="Before you add an account"
      tone="neutral"
    >
      <p>
        Plaid securely connects your institution. Balebase imports up to 24
        months of account balances and transaction details so authorized
        organization members can review and annotate them. We do not receive
        your bank credentials, never sell customer information, and let you
        disconnect later.{" "}
        <ButtonLink
          href={`${websiteUrl}/privacy`}
          iconEnd="external"
          variant="link"
        >
          Privacy details
        </ButtonLink>
      </p>
    </Banner>
  );
}

function FinanceSetupNotice() {
  return (
    <div id={setupNoticeId}>
      <Banner
        announce={false}
        icon="key"
        title="Plaid setup is incomplete"
        tone="warning"
      >
        Add the Plaid credentials and token-encryption key before connecting.
      </Banner>
    </div>
  );
}

function usePlaidConnect(
  load: () => Promise<void>,
  setError: Dispatch<SetStateAction<string | undefined>>,
  setNotice: Dispatch<SetStateAction<string | undefined>>,
) {
  const [busy, setBusy] = useState(false);
  const resumedOAuth = useRef(false);
  const complete = useCallback(
    async (publicToken: string, metadata: PlaidLinkMetadata) => {
      setBusy(true);
      setError(undefined);
      try {
        const connection = await exchangePlaidPublicToken(publicToken, {
          id: metadata.institution?.institution_id ?? null,
          name: metadata.institution?.name ?? null,
        });
        clearOAuthState();
        const result = await syncFinanceConnection(connection.connectionId);
        await load();
        setNotice(syncNotice(result));
      } catch (cause) {
        setError(messageFrom(cause));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, setError, setNotice],
  );
  useOAuthResume(complete, resumedOAuth, setBusy, setError);

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await createPlaidLinkToken();
      localStorage.setItem(linkTokenStorageKey, result.linkToken);
      await launchPlaid(result.linkToken, undefined, complete, (message) => {
        setError(message);
        setBusy(false);
      });
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  };
  return { busy, connect };
}

function useOAuthResume(
  complete: (token: string, metadata: PlaidLinkMetadata) => Promise<void>,
  resumed: { current: boolean },
  setBusy: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | undefined>>,
) {
  useEffect(() => {
    if (!hasOAuthState() || resumed.current) return;
    resumed.current = true;
    const token = localStorage.getItem(linkTokenStorageKey);
    if (!token) {
      setError("The bank connection expired. Please start again.");
      clearOAuthState();
      return;
    }
    setBusy(true);
    void launchPlaid(token, window.location.href, complete, (message) => {
      setError(message);
      setBusy(false);
    });
  }, [complete, resumed, setBusy, setError]);
}

let plaidScript: Promise<boolean> | undefined;

/**
 * Loads Plaid Link on first use rather than on every page, so its script
 * never runs on pages that carry secrets in the URL, such as signing links.
 */
function loadPlaid() {
  plaidScript ??= new Promise<boolean>((resolve) => {
    if (window.Plaid) return resolve(true);
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.onload = () => resolve(Boolean(window.Plaid));
    script.onerror = () => {
      plaidScript = undefined;
      script.remove();
      resolve(false);
    };
    document.head.append(script);
  });
  return plaidScript;
}

async function launchPlaid(
  token: string,
  receivedRedirectUri: string | undefined,
  onSuccess: (token: string, metadata: PlaidLinkMetadata) => Promise<void>,
  onExit: (message: string | undefined) => void,
) {
  if (!(await loadPlaid()) || !window.Plaid) {
    onExit("Plaid Link could not load. Check your connection and try again.");
    return;
  }
  let handler: PlaidLinkHandler | undefined;
  const configuration = {
    onExit: (error: PlaidLinkError | null) => {
      handler?.destroy();
      clearOAuthState();
      onExit(error?.error_message ?? undefined);
    },
    onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => {
      handler?.destroy();
      void onSuccess(publicToken, metadata);
    },
    token,
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
  };
  handler = window.Plaid.create(configuration);
  handler.open();
}

function hasOAuthState() {
  return new URLSearchParams(window.location.search).has("oauth_state_id");
}

function clearOAuthState() {
  localStorage.removeItem(linkTokenStorageKey);
  if (hasOAuthState())
    window.history.replaceState(window.history.state, "", "/finance");
}

function syncNotice(result: {
  added: number;
  modified: number;
  removed: number;
}) {
  return `Sync complete: ${result.added} added, ${result.modified} updated, ${result.removed} removed.`;
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update finances.";
}

function institutionName(connection: FinanceConnection) {
  return connection.institutionName ?? "this institution";
}

function confirmDataDeletion(connection: FinanceConnection) {
  return confirmDialog({
    confirmLabel: "Delete data",
    message:
      "This also deletes its transaction annotations and cannot be undone.",
    title: `Permanently delete all imported data for ${institutionName(connection)}?`,
    tone: "danger",
  });
}

function confirmDisconnect(connection: FinanceConnection) {
  return confirmDialog({
    confirmLabel: "Disconnect",
    message:
      "Plaid access will be revoked, but imported transactions and annotations will remain.",
    title: `Disconnect ${institutionName(connection)}?`,
    tone: "danger",
  });
}
