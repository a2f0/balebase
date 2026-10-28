import {
  Badge,
  Banner,
  Button,
  Card,
  cx,
  EmptyState,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@balebase/ui/react";
import type { FinanceAccountDetail } from "@balebase/validators/finance";
import { useCallback } from "react";
import { api } from "./apiClient";
import { connectionTone } from "./FinanceAccounts";
import { FinanceSourceFields, type SourceField } from "./FinanceSourceFields";
import { FinanceSyncSettings } from "./FinanceSyncSettings";
import {
  formatDateTime,
  formatDay,
  formatImportedHistory,
  formatMoney,
} from "./financeFormat";
import { formatLabel } from "./labels";
import { useLoad } from "./useLoad";
import {
  financeConnectionPath,
  financeTransactionPath,
  handleNavigation,
} from "./workspacePaths";

export function FinanceAccountPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (path: string) => void;
}) {
  const { data, error, setData } = useAccount(id);
  return (
    <Page>
      <PageHeader
        actions={
          data && (
            <Button
              onClick={() =>
                onNavigate(financeConnectionPath(data.connection.id))
              }
            >
              View connection
            </Button>
          )
        }
        eyebrow="Finance account"
        title={data?.account.name ?? "Account"}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {!data && !error && <LoadingState label="Loading account…" />}
        {data && (
          <>
            <AccountSummary data={data} onNavigate={onNavigate} />
            <FinanceSyncSettings
              id={data.connection.id}
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
            <RecentTransactions
              onNavigate={onNavigate}
              transactions={data.recentTransactions}
            />
            <PageSection
              description="Values as Plaid reports them. Plaid support asks for the account and Item IDs."
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

function AccountSummary({
  data: { account, connection },
  onNavigate,
}: {
  data: FinanceAccountDetail;
  onNavigate: (path: string) => void;
}) {
  const connectionPath = financeConnectionPath(connection.id);
  return (
    <PageSection title="Account">
      <Card>
        <dl className="keyValue">
          <dt>Institution</dt>
          <dd>
            <a
              href={connectionPath}
              onClick={(event) =>
                handleNavigation(event, connectionPath, onNavigate)
              }
            >
              {connection.institutionName ?? "Financial institution"}
            </a>
          </dd>
          <dt>Connection</dt>
          <dd>
            <Badge dot tone={connectionTone(connection.status)}>
              {formatLabel(connection.status)}
            </Badge>
          </dd>
          <dt>Current balance</dt>
          <dd>{formatMoney(account.currentBalance, account.currencyCode)}</dd>
          <dt>Available balance</dt>
          <dd>{formatMoney(account.availableBalance, account.currencyCode)}</dd>
          <dt>Balances as of</dt>
          <dd>{formatDateTime(account.updatedAt)}</dd>
          <dt>Imported history</dt>
          <dd>{formatImportedHistory(account.transactions)}</dd>
        </dl>
      </Card>
    </PageSection>
  );
}

function RecentTransactions({
  onNavigate,
  transactions,
}: {
  onNavigate: (path: string) => void;
  transactions: FinanceAccountDetail["recentTransactions"];
}) {
  return (
    <PageSection
      description="The ten newest imported transactions."
      title="Recent transactions"
    >
      {transactions.length ? (
        <Card className="financeListCard" flush>
          <ul className="rowList">
            {transactions.map((transaction) => {
              const path = financeTransactionPath(transaction.id);
              return (
                <li className="row rowInteractive" key={transaction.id}>
                  <div className="rowMain">
                    <a
                      className="rowTitle rowTarget"
                      href={path}
                      onClick={(event) =>
                        handleNavigation(event, path, onNavigate)
                      }
                    >
                      {transaction.merchantName ?? transaction.name}
                    </a>
                    <span className="rowMeta">
                      {formatDay(transaction.transactionDate)}
                      {transaction.pending && " · Pending"}
                    </span>
                  </div>
                  <span
                    className={cx(
                      "financeAmount",
                      transaction.amount < 0 && "financeAmountCredit",
                    )}
                  >
                    {formatMoney(-transaction.amount, transaction.currencyCode)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : (
        <EmptyState icon="finance" title="No transactions imported yet">
          Sync the connection to import this account's transactions.
        </EmptyState>
      )}
    </PageSection>
  );
}

function useAccount(id: string) {
  return useLoad(
    useCallback(() => api.finance.account(id), [id]),
    "Could not load account.",
  );
}

function sourceFields({
  account,
  connection,
}: FinanceAccountDetail): SourceField[] {
  return [
    { label: "Name", value: account.name },
    { label: "Official name", value: account.officialName },
    { label: "Type", value: account.type },
    { label: "Subtype", value: account.subtype },
    { label: "Mask", value: account.mask },
    { label: "Currency", value: account.currencyCode },
    {
      copyable: true,
      label: "Plaid account ID",
      value: account.plaidAccountId,
    },
    { copyable: true, label: "Plaid Item ID", value: connection.plaidItemId },
    { copyable: true, label: "Balebase ID", value: account.id },
  ];
}
