import {
  Banner,
  Button,
  ButtonLink,
  Page,
  PageBody,
  PageHeader,
  Toast,
} from "@balebase/ui/react";
import type {
  FinanceConnection,
  FinanceData,
  FinanceTransaction,
  FinanceTransactionAnnotation,
} from "@balebase/validators/finance";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { websiteUrl } from "../shared/config";
import { errorMessage } from "../shared/errors";
import { useAction } from "../shared/useAction";
import {
  expenseCategoryFiltersFor,
  type FinancePage,
  financeOverviewPath,
  financePageFor,
  financePages,
} from "../workspace/workspacePaths";
import {
  FinanceAccounts,
  FinanceConnectionAlert,
  FinanceConnections,
} from "./FinanceAccounts";
import { FinanceCategories } from "./FinanceCategories";
import { FinanceReports } from "./FinanceReports";
import { FinanceTransactionHistory } from "./FinanceTransactionHistory";
import {
  confirmDataDeletion,
  confirmDisconnect,
  syncNotice,
} from "./financeConnectionActions";
import { selectFinanceAccount } from "./financeTransactions";
import {
  type FinanceListingState,
  initialFilters,
  useFinanceData,
} from "./useFinanceData";

const linkTokenStorageKey = "balebase.plaid.linkToken";
/** Set while Link runs in update mode, so an OAuth return repairs that
 * connection instead of exchanging a token for a new one. It names the link
 * token it belongs to, so a flow started in another tab never adopts it. */
const updateConnectionStorageKey = "balebase.plaid.updateConnection";

export function Finance({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const page = financePageFor(pathname);
  const { load, setData, onFiltersChange, ...listing } = useFinanceData(
    page === "overview" ? expenseCategoryFiltersFor(pathname) : null,
  );
  const { error, notice, run, setError, setNotice, ...action } = useAction(
    "Could not update finances.",
  );
  const plaid = usePlaidConnect(load, setError, setNotice);
  const actions = financeActions(load, run);
  const busy = action.busy || plaid.busy;

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
      onFiltersChange={(next) => {
        onFiltersChange(next);
        // Category filters live in the path so they can be bookmarked.
        const path = financeOverviewPath(next);
        if (path !== pathname) onNavigate(path);
      }}
      onNavigate={onNavigate}
      onReload={load}
      onRepair={plaid.repair}
      onSync={actions.sync}
      page={page}
    />
  );
}

/**
 * Assigns a transaction's single expense category right away, updating the
 * list and category counts optimistically and restoring them on failure.
 */
function categorizeTransaction(
  setData: Dispatch<SetStateAction<FinanceData | undefined>>,
  setError: (message: string | undefined) => void,
) {
  return async (transaction: FinanceTransaction, categoryId: string | null) => {
    const previous = transaction.expenseCategoryId;
    if (previous === categoryId) return;
    setError(undefined);
    setData((current) =>
      withCategory(current, transaction.id, previous, categoryId),
    );
    try {
      await api.finance.setTransactionCategory(transaction.id, categoryId);
    } catch (cause) {
      setData((current) =>
        withCategory(current, transaction.id, categoryId, previous),
      );
      setError(errorMessage(cause, "Could not update finances."));
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
  runAction: ReturnType<typeof useAction>["run"],
) {
  async function run(action: () => Promise<string>) {
    await runAction(
      async () => {
        const notice = await action();
        await load();
        return notice;
      },
      (notice) => notice,
    );
  }
  return {
    annotate: (
      transaction: FinanceTransaction,
      input: FinanceTransactionAnnotation,
    ) =>
      run(async () => {
        await api.finance.updateTransactionAnnotation(transaction.id, input);
        return "Transaction annotation saved.";
      }),
    deleteData: async (connection: FinanceConnection) => {
      if (await confirmDataDeletion(connection)) {
        await run(async () => {
          await api.finance.deleteConnectionData(connection.id);
          return "Imported bank data permanently deleted.";
        });
      }
    },
    disconnect: async (connection: FinanceConnection) => {
      if (await confirmDisconnect(connection)) {
        await run(async () => {
          await api.finance.disconnectConnection(connection.id);
          return "Bank disconnected. Imported history was retained.";
        });
      }
    },
    sync: (id: string) =>
      run(async () => syncNotice(await api.finance.startSync(id))),
  };
}

const setupNoticeId = "finance-setup-notice";

interface OverviewHandlers {
  busy: boolean;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotation,
  ) => Promise<void>;
  onCategorize: (
    transaction: FinanceTransaction,
    categoryId: string | null,
  ) => Promise<void>;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onNavigate: (pathname: string) => void;
  onRepair: (connection: FinanceConnection) => Promise<void>;
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
  const connectable = page === "overview" || page === "connections";
  return (
    <Page>
      <FinanceHeader
        busy={handlers.busy}
        connectable={connectable}
        onConnect={handlers.onConnect}
        onNavigate={handlers.onNavigate}
        page={page}
        unconfigured={unconfigured}
      />
      <PageBody>
        <FinanceNotices
          connectable={connectable}
          error={
            error ??
            (page === "overview" || page === "connections"
              ? undefined
              : handlers.loadError)
          }
          notice={notice}
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
            onShowTransactions={(category) =>
              handlers.onFiltersChange({
                ...initialFilters,
                categorySlug: category.slug,
              })
            }
          />
        )}
        {page === "connections" && (
          <FinanceConnections
            busy={handlers.busy}
            connections={data?.connections}
            loadError={handlers.loadError}
            onConnect={handlers.onConnect}
            onDeleteData={handlers.onDeleteData}
            onDisconnect={handlers.onDisconnect}
            onNavigate={handlers.onNavigate}
            onReload={onReload}
            onRepair={handlers.onRepair}
            onSync={handlers.onSync}
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
  const categoryId = data?.categories.find(
    ({ slug }) => slug === filters.categorySlug,
  )?.id;
  const transactions = loading
    ? undefined
    : data?.transactions.filter(
        (transaction) =>
          (!filters.uncategorized || !transaction.expenseCategoryId) &&
          (!filters.categorySlug ||
            transaction.expenseCategoryId === categoryId),
      );
  return (
    <>
      <FinanceConnectionAlert
        connections={data?.connections}
        onNavigate={handlers.onNavigate}
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
        nextCursor={data?.nextCursor}
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
  connectable,
  onConnect,
  onNavigate,
  page,
  unconfigured,
}: {
  busy: boolean;
  connectable: boolean;
  onConnect: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  page: FinancePage;
  unconfigured: boolean;
}) {
  return (
    <PageHeader
      actions={
        connectable && (
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
        <AppLink
          aria-current={page === item.page ? "page" : undefined}
          className="tab"
          href={item.path}
          key={item.path}
          onNavigate={onNavigate}
        >
          {item.label}
        </AppLink>
      ))}
      tabsLabel="Finance sections"
      title="Finance"
    />
  );
}

function FinanceNotices({
  connectable,
  error,
  notice,
  showDataNotice,
  unconfigured,
}: {
  /** Setup and data-handling notices belong beside the Connect bank action. */
  connectable: boolean;
  error: string | undefined;
  notice: string | undefined;
  showDataNotice: boolean;
  unconfigured: boolean;
}) {
  return (
    <>
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {connectable && (unconfigured || showDataNotice) && (
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
          href={`${websiteUrl}/privacy/`}
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
  setError: (message: string | undefined) => void,
  setNotice: (message: string | undefined) => void,
) {
  const [busy, setBusy] = useState(false);
  const resumedOAuth = useRef(false);
  const complete = useCallback(
    async (
      publicToken: string,
      metadata: PlaidLinkMetadata,
      repairing: string | undefined,
    ) => {
      setBusy(true);
      setError(undefined);
      try {
        // Update mode keeps the Item and its access token, so there is no
        // public token to exchange; a sync confirms the repaired login.
        const connectionId =
          repairing ??
          (
            await api.finance.exchangePlaidPublicToken(publicToken, {
              id: metadata.institution?.institution_id ?? null,
              name: metadata.institution?.name ?? null,
            })
          ).connectionId;
        clearOAuthState();
        const result = await api.finance.startSync(connectionId);
        await load();
        setNotice(syncNotice(result));
      } catch (cause) {
        setError(errorMessage(cause, "Could not update finances."));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, setError, setNotice],
  );
  useOAuthResume(complete, resumedOAuth, setBusy, setError);

  const start = async (
    linkToken: () => Promise<{ linkToken: string }>,
    connectionId: string | undefined,
  ) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await linkToken();
      localStorage.setItem(linkTokenStorageKey, result.linkToken);
      if (connectionId)
        localStorage.setItem(
          updateConnectionStorageKey,
          JSON.stringify({ connectionId, linkToken: result.linkToken }),
        );
      // This session's repair target is bound here, not read back from
      // storage another tab can overwrite.
      await launchPlaid(
        result.linkToken,
        undefined,
        (publicToken, metadata) =>
          complete(publicToken, metadata, connectionId),
        (message) => {
          setError(message);
          setBusy(false);
        },
      );
    } catch (cause) {
      setError(errorMessage(cause, "Could not update finances."));
      setBusy(false);
    }
  };
  return {
    busy,
    connect: () => start(() => api.finance.createPlaidLinkToken(), undefined),
    repair: (connection: FinanceConnection) =>
      start(
        () => api.finance.createPlaidUpdateLinkToken(connection.id),
        connection.id,
      ),
  };
}

function useOAuthResume(
  complete: (
    token: string,
    metadata: PlaidLinkMetadata,
    repairing: string | undefined,
  ) => Promise<void>,
  resumed: { current: boolean },
  setBusy: Dispatch<SetStateAction<boolean>>,
  setError: (message: string | undefined) => void,
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
    const repairing = updateConnectionFor(token);
    setBusy(true);
    void launchPlaid(
      token,
      window.location.href,
      (publicToken, metadata) => complete(publicToken, metadata, repairing),
      (message) => {
        setError(message);
        setBusy(false);
      },
    );
  }, [complete, resumed, setBusy, setError]);
}

/** The connection an update-mode Link session repairs, if `token` started one. */
function updateConnectionFor(token: string) {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(updateConnectionStorageKey) ?? "null",
    );
    if (
      stored &&
      typeof stored === "object" &&
      "linkToken" in stored &&
      "connectionId" in stored &&
      stored.linkToken === token &&
      typeof stored.connectionId === "string"
    )
      return stored.connectionId;
  } catch {
    // A malformed marker cannot name a connection; treat it as a new one.
  }
  return undefined;
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
  localStorage.removeItem(updateConnectionStorageKey);
  if (hasOAuthState())
    window.history.replaceState(window.history.state, "", "/finance");
}
