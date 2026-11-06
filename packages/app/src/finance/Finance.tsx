import { productName } from "@balebase/ui/brand";
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
import { financeLimits } from "@balebase/validators/rules";
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
import { formatDateTime } from "../shared/labels";
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
import { FinanceRules } from "./FinanceRules";
import { FinanceTransactionHistory } from "./FinanceTransactionHistory";
import {
  confirmDataDeletion,
  confirmDisconnect,
  syncNotice,
} from "./financeConnectionActions";
import type { OverviewHandlers } from "./financeOverviewHandlers";
import { createRuleAction } from "./financeRuleAction";
import {
  filterTransactions,
  selectFinanceAccount,
} from "./financeTransactions";
import {
  reportLoginRepair,
  retryPendingLoginRepairs,
} from "./loginRepairReports";
import {
  linkDiagnostics,
  linkErrorMessage,
  type PlaidLinkSession,
} from "./plaidLinkDiagnostics";
import { type CacheScope, refused } from "./transactionCache";
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
  opensByPayee,
  pathname,
  scope,
}: {
  onNavigate: (pathname: string) => void;
  opensByPayee?: boolean | undefined;
  pathname: string;
  /** Whose saved transactions this device reads; memory only without it. */
  scope?: CacheScope | undefined;
}) {
  const page = financePageFor(pathname);
  const { load, onRefused, setData, onFiltersChange, ...listing } =
    useFinanceData(
      page === "overview" ? expenseCategoryFiltersFor(pathname) : null,
      scope,
    );
  const { error, notice, run, setError, setNotice, ...action } = useAction(
    "Could not update finances.",
  );
  // Saves and actions that finish after navigation reload with the loader
  // for the page shown by then (the overview's keeps transactions).
  const latestLoad = useRef(load);
  latestLoad.current = load;
  const reloadLatest = useCallback(() => latestLoad.current(), []);
  const plaid = usePlaidConnect(reloadLatest, onRefused, setError, setNotice);
  const actions = financeActions(reloadLatest, onRefused, run);
  // A category save, a row's or a bulk one, holds every category control
  // until it finishes, so two saves never land out of order.
  const [categorizing, setCategorizing] = useState(false);
  const busy = action.busy || plaid.busy || categorizing;

  return (
    <FinanceView
      busy={busy}
      {...listing}
      error={error}
      notice={notice}
      onAnnotate={actions.annotate}
      onCreateRule={actions.createRule}
      onCategorize={categorizeTransaction(
        setData,
        setError,
        setCategorizing,
        reloadLatest,
        onRefused,
      )}
      onCategorizeMany={categorizeTransactions(
        setData,
        setError,
        setCategorizing,
        reloadLatest,
        onRefused,
      )}
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
      onRefused={onRefused}
      // Category and rule saves on Categories reload once they finish, maybe
      // after navigation: with the loader for the page shown by then.
      onReload={reloadLatest}
      onRepair={plaid.repair}
      onSync={actions.sync}
      opensByPayee={opensByPayee}
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
  setSaving: (saving: boolean) => void,
  refresh: () => Promise<void>,
  onRefused: (cause: unknown) => Promise<void>,
) {
  return async (transaction: FinanceTransaction, categoryId: string | null) => {
    const previous = transaction.expenseCategoryId;
    if (previous === categoryId) return;
    const change = [{ from: previous, id: transaction.id, to: categoryId }];
    setError(undefined);
    setData((current) => withCategories(current, change));
    setSaving(true);
    try {
      await api.finance.setTransactionCategory(transaction.id, categoryId);
      // Saved transactions catch up, so the change outlasts going offline.
      await refresh();
    } catch (cause) {
      setData((current) => withCategories(current, reversed(change)));
      setError(errorMessage(cause, "Could not update finances."));
      if (refused(cause)) await onRefused(cause);
    } finally {
      setSaving(false);
    }
  };
}

/**
 * Gives the selected transactions one category, optimistically, saving them
 * a request's worth at a time. A failed request restores its rows and the
 * ones not yet sent; rows already saved keep their new category.
 */
function categorizeTransactions(
  setData: Dispatch<SetStateAction<FinanceData | undefined>>,
  setError: (message: string | undefined) => void,
  setSaving: (saving: boolean) => void,
  refresh: () => Promise<void>,
  onRefused: (cause: unknown) => Promise<void>,
) {
  return async (
    transactions: FinanceTransaction[],
    categoryId: string | null,
  ) => {
    setSaving(true);
    try {
      return await saveCategories(
        setData,
        setError,
        transactions,
        categoryId,
        onRefused,
      );
    } finally {
      // A load during the save (a filter change, sync polling) replaced the
      // optimistic rows, and a rollback may have landed on it; the server's
      // rows and counts settle both.
      await refresh();
      setSaving(false);
    }
  };
}

async function saveCategories(
  setData: Dispatch<SetStateAction<FinanceData | undefined>>,
  setError: (message: string | undefined) => void,
  transactions: FinanceTransaction[],
  categoryId: string | null,
  onRefused: (cause: unknown) => Promise<void>,
) {
  const changes = transactions
    .filter(({ expenseCategoryId }) => expenseCategoryId !== categoryId)
    .map(({ expenseCategoryId, id }) => ({
      from: expenseCategoryId,
      id,
      to: categoryId,
    }));
  setError(undefined);
  setData((current) => withCategories(current, changes));
  for (
    let start = 0;
    start < changes.length;
    start += financeLimits.bulkCategorize
  ) {
    const batch = changes.slice(start, start + financeLimits.bulkCategorize);
    try {
      await api.finance.setTransactionsCategory(
        batch.map(({ id }) => id),
        categoryId,
      );
    } catch (cause) {
      const unsaved = reversed(changes.slice(start));
      setData((current) => withCategories(current, unsaved));
      setError(errorMessage(cause, "Could not update finances."));
      if (refused(cause)) await onRefused(cause);
      return false;
    }
  }
  return true;
}

interface CategoryChange {
  from: string | null;
  id: string;
  to: string | null;
}

function reversed(changes: CategoryChange[]): CategoryChange[] {
  return changes.map(({ from, id, to }) => ({ from: to, id, to: from }));
}

function withCategories(
  data: FinanceData | undefined,
  changes: CategoryChange[],
): FinanceData | undefined {
  if (!data || !changes.length) return data;
  const byId = new Map(changes.map((change) => [change.id, change]));
  const counts = new Map<string | null, number>();
  for (const { from, to } of changes) {
    counts.set(to, (counts.get(to) ?? 0) + 1);
    counts.set(from, (counts.get(from) ?? 0) - 1);
  }
  return {
    ...data,
    categories: data.categories.map((category) => {
      const change = counts.get(category.id) ?? 0;
      return change
        ? { ...category, transactionCount: category.transactionCount + change }
        : category;
    }),
    transactions: data.transactions.map((transaction) => {
      const change = byId.get(transaction.id);
      return change
        ? { ...transaction, expenseCategoryId: change.to }
        : transaction;
    }),
  };
}

function financeActions(
  load: () => Promise<void>,
  onRefused: (cause: unknown) => Promise<void>,
  runAction: ReturnType<typeof useAction>["run"],
) {
  /** Runs `action` as Finance's one action; resolves whether it saved. */
  function save(action: () => Promise<string>) {
    return runAction(
      async () => {
        try {
          const notice = await action();
          await load();
          return notice;
        } catch (cause) {
          // Access ended: nothing shown or saved stays.
          if (refused(cause)) await onRefused(cause);
          throw cause;
        }
      },
      (notice) => notice,
    );
  }
  async function run(action: () => Promise<string>) {
    await save(action);
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
    createRule: createRuleAction(save),
  };
}

const setupNoticeId = "finance-setup-notice";

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
        {/* Reports read their own totals: they go when what Finance shows
            does (access ended here or in another tab). */}
        {page === "reports" && data && (
          <FinanceReports
            onNavigate={handlers.onNavigate}
            onRefused={handlers.onRefused}
          />
        )}
        {page === "categories" && (
          <FinanceCategories
            categories={data?.categories}
            onChanged={onReload}
            onRefused={handlers.onRefused}
            onShowTransactions={(category) =>
              handlers.onFiltersChange({
                ...initialFilters,
                categorySlug: category.slug,
              })
            }
          />
        )}
        {page === "rules" && (
          <FinanceRules
            categories={data?.categories}
            onChanged={onReload}
            onNavigate={handlers.onNavigate}
            onRefused={handlers.onRefused}
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
  refreshing,
  loadError,
  savedCopy,
  saving,
  visible,
  onFiltersChange,
  onLoadMore,
  onReload,
  opensByPayee,
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
  // Every saved transaction is on the device: filter and page locally.
  const matching =
    loading || !data
      ? undefined
      : filterTransactions(data.transactions, filters, data.categories);
  return (
    <>
      {savedCopy && (
        <Banner
          actions={
            <Button onClick={() => void onReload()} size="sm">
              Retry
            </Button>
          }
          title="Showing transactions saved on this device"
          tone="warning"
        >
          {productName} can’t be reached right now. These were last updated{" "}
          {formatDateTime(savedCopy)}; changes made here may not save.
        </Banner>
      )}
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
        initialView={opensByPayee ? "payees" : "list"}
        filters={filters}
        onFiltersChange={onFiltersChange}
        loadError={loadError}
        loadingLabel={
          saving === undefined
            ? undefined
            : `Saving transactions to this device (${saving.toLocaleString()})…`
        }
        onLoadMore={onLoadMore}
        onReload={onReload}
        busy={handlers.busy || refreshing}
        categories={data?.categories ?? []}
        onAnnotate={handlers.onAnnotate}
        onCategorize={handlers.onCategorize}
        onCategorizeMany={handlers.onCategorizeMany}
        onClearFilter={() => onFiltersChange({ ...filters, accountIds: [] })}
        onNavigate={handlers.onNavigate}
        onCreateRule={handlers.onCreateRule}
        onSelectAnnotation={(transactionId) =>
          setSelectedTransactionId((current) =>
            current === transactionId ? undefined : transactionId,
          )
        }
        selectedTransactionId={selectedTransactionId}
        matching={matching}
        visible={visible}
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
  onRefused: (cause: unknown) => Promise<void>,
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
      linkToken: string,
    ) => {
      setBusy(true);
      setError(undefined);
      try {
        // Update mode keeps the Item and its access token, so there is no
        // public token to exchange; the repair is recorded, then a sync
        // confirms the repaired login.
        const connectionId =
          repairing ??
          (
            await api.finance.exchangePlaidPublicToken(publicToken, {
              id: metadata.institution?.institution_id ?? null,
              name: metadata.institution?.name ?? null,
            })
          ).connectionId;
        // The Link session's token shows this report follows the update
        // session the API opened; it is accepted once. It is kept to retry
        // before the OAuth state goes, so a failure cannot lose it.
        const recorded = repairing
          ? await reportLoginRepair(repairing, linkToken)
          : true;
        clearOAuthState();
        const result = await api.finance.startSync(connectionId);
        await load();
        setNotice(syncNotice(result));
        if (!recorded)
          setError(
            "The login was repaired, but its history could not be saved yet. It will be retried.",
          );
      } catch (cause) {
        setError(errorMessage(cause, "Could not update finances."));
        await (refused(cause) ? onRefused(cause) : load());
      } finally {
        setBusy(false);
      }
    },
    [load, onRefused, setError, setNotice],
  );
  useOAuthResume(complete, resumedOAuth, setBusy, setError);
  useEffect(() => {
    void retryPendingLoginRepairs();
  }, []);

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
        { connectionId, oauthResume: false },
        (publicToken, metadata) =>
          complete(publicToken, metadata, connectionId, result.linkToken),
        (message) => {
          setError(message);
          setBusy(false);
        },
      );
    } catch (cause) {
      setError(errorMessage(cause, "Could not update finances."));
      setBusy(false);
      if (refused(cause)) await onRefused(cause);
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
    linkToken: string,
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
      { connectionId: repairing, oauthResume: true },
      (publicToken, metadata) =>
        complete(publicToken, metadata, repairing, token),
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
  session: PlaidLinkSession,
  onSuccess: (token: string, metadata: PlaidLinkMetadata) => Promise<void>,
  onExit: (message: string | undefined) => void,
) {
  if (!(await loadPlaid()) || !window.Plaid) {
    onExit("Plaid Link could not load. Check your connection and try again.");
    return;
  }
  let handler: PlaidLinkHandler | undefined;
  const diagnostics = linkDiagnostics(session);
  const configuration = {
    onEvent: diagnostics.onEvent,
    onExit: (error: PlaidLinkError | null, metadata: PlaidLinkExitMetadata) => {
      handler?.destroy();
      clearOAuthState();
      diagnostics.report("exit", error, metadata ?? {});
      onExit(linkErrorMessage(error, metadata ?? {}));
    },
    onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => {
      handler?.destroy();
      diagnostics.report("success", null, metadata);
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
