import { Banner, Button, LoadingState, Toast } from "@balebase/ui/react";
import type { ExpenseCategory } from "@balebase/validators/finance";
import { financeCategoriesPath } from "../workspace/workspacePaths";
import { FinanceCategoryRules } from "./FinanceCategoryRules";
import { useFinanceSave } from "./financeSave";

/** Finance's Rules tab: categorization rules and the form that adds them. */
export function FinanceRules({
  categories,
  onChanged,
  onNavigate,
  onRefused,
}: {
  categories: ExpenseCategory[] | undefined;
  onChanged: () => Promise<void>;
  onNavigate: (pathname: string) => void;
  /** A save or load was refused: access ended. */
  onRefused: (cause: unknown) => Promise<void>;
}) {
  const { busy, error, notice, run } = useFinanceSave(
    "Could not save the rule.",
    onChanged,
    onRefused,
  );
  return (
    <>
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {categories?.length === 0 && (
        <Banner
          actions={
            <Button onClick={() => onNavigate(financeCategoriesPath)} size="sm">
              Open categories
            </Button>
          }
          icon="layers"
          title="Add an expense category first"
          tone="neutral"
        >
          Each rule gives a payee's transactions one of your expense categories.
        </Banner>
      )}
      {/* Gone with the categories when access ends, and loaded afresh. */}
      {categories ? (
        <FinanceCategoryRules
          busy={busy}
          categories={categories}
          onRefused={onRefused}
          run={run}
        />
      ) : (
        <LoadingState label="Loading rules…" />
      )}
    </>
  );
}
