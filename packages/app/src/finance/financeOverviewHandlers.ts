import type {
  FinanceConnection,
  FinanceTransaction,
  FinanceTransactionAnnotation,
} from "@balebase/validators/finance";
import type { CreateRule } from "./financeRuleAction";

/** What Finance's pages act with, and how its overview starts. */
export interface OverviewHandlers {
  busy: boolean;
  onCreateRule: CreateRule;
  onAnnotate: (
    transaction: FinanceTransaction,
    input: FinanceTransactionAnnotation,
  ) => Promise<void>;
  onCategorize: (
    transaction: FinanceTransaction,
    categoryId: string | null,
  ) => Promise<void>;
  onCategorizeMany: (
    transactions: FinanceTransaction[],
    categoryId: string | null,
  ) => Promise<boolean>;
  onConnect: () => Promise<void>;
  onDeleteData: (connection: FinanceConnection) => Promise<void>;
  onDisconnect: (connection: FinanceConnection) => Promise<void>;
  onNavigate: (pathname: string) => void;
  /** Changes the period filter in place, from a page other than the list. */
  onPeriodChange: (year: number | null) => void;
  /** A request was refused: access ended, so nothing shown or saved stays. */
  onRefused: (cause: unknown) => Promise<void>;
  onRepair: (connection: FinanceConnection) => Promise<void>;
  onSync: (id: string) => Promise<void>;
  /** Transactions open grouped by payee (the person's Account choice). */
  opensByPayee?: boolean | undefined;
}
