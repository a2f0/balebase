import { PageSection } from "@balebase/ui/react";
import type {
  FinanceTransaction,
  FinanceTransactionSource,
} from "@balebase/validators/finance";
import { FinanceSourceFields, type SourceField } from "./FinanceSourceFields";

/** The imported Plaid record behind a transaction, with values unformatted. */
export function FinanceTransactionSourceData({
  source,
  transaction,
}: {
  source: FinanceTransactionSource;
  transaction: FinanceTransaction;
}) {
  return (
    <PageSection
      title="Source data"
      description="Fields as imported from Plaid. Notes and categories you add are not included."
    >
      <FinanceSourceFields fields={sourceFields(transaction, source)} />
    </PageSection>
  );
}

function sourceFields(
  transaction: FinanceTransaction,
  source: FinanceTransactionSource,
): SourceField[] {
  return [
    { label: "Description", value: transaction.name },
    { label: "Merchant", value: transaction.merchantName },
    {
      label: "Amount",
      value: [transaction.amount, transaction.currencyCode]
        .filter((part) => part !== null)
        .join(" "),
      hint: "Positive amounts leave the account; negative amounts enter it.",
    },
    { label: "Date", value: transaction.transactionDate },
    { label: "Authorized date", value: transaction.authorizedDate },
    { label: "Status", value: transaction.pending ? "pending" : "posted" },
    { label: "Category", value: transaction.categoryPrimary },
    { label: "Detailed category", value: transaction.categoryDetailed },
    { label: "Payment channel", value: transaction.paymentChannel },
    { label: "Institution", value: source.institutionName },
    { label: "Account", value: transaction.accountName },
    { label: "Account official name", value: source.accountOfficialName },
    { label: "Account mask", value: source.accountMask },
    {
      label: "Account type",
      value: [source.accountType, source.accountSubtype]
        .filter((part) => part !== null)
        .join(" / "),
    },
    {
      copyable: true,
      label: "Plaid transaction ID",
      value: source.plaidTransactionId,
    },
    {
      copyable: true,
      label: "Pending transaction ID",
      value: source.pendingTransactionId,
    },
    { copyable: true, label: "Balebase ID", value: transaction.id },
    {
      label: "Last synced",
      value: source.updatedAt,
      hint: "When a Plaid sync last wrote this record.",
    },
  ];
}
