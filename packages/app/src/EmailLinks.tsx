import {
  Button,
  cx,
  Icon,
  type IconName,
  Select,
  Toast,
} from "@balebase/ui/react";
import type { FinanceTransactionMatch } from "@balebase/validators/finance";
import type {
  InboundEmailLink,
  InboundEmailLinkTarget,
} from "@balebase/validators/inbox";
import { type FormEvent, useEffect, useState } from "react";
import {
  describeEmailLink,
  formatTransactionDate,
} from "./emailLinkDescription";
import { equipmentName, equipmentTypeLabel } from "./equipmentLabels";
import { formatMoney } from "./financeFormat";
import { AppLink } from "./shared/AppLink";
import { api } from "./shared/apiClient";
import { errorMessage } from "./shared/errors";
import { useLoad } from "./shared/useLoad";
import { equipmentPath, libraryPath } from "./workspace/workspacePaths";

type LinkTab = "equipment" | "folder" | "transaction";

/**
 * The folders, equipment, and transactions an email is linked to, with
 * controls to add and remove links while the email is outside Trash.
 */
export function EmailLinks({
  canAccessFinance,
  editable,
  emailId,
  links,
  onChange,
  onNavigate,
}: {
  canAccessFinance: boolean;
  editable: boolean;
  emailId: string;
  links: InboundEmailLink[];
  /** Receives an update so results that finish out of order compose. */
  onChange: (update: (links: InboundEmailLink[]) => InboundEmailLink[]) => void;
  onNavigate: (pathname: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [workingId, setWorkingId] = useState<string>();
  const [error, setError] = useState<string>();

  async function link(target: InboundEmailLinkTarget) {
    setError(undefined);
    try {
      const created = await api.inbox.link(emailId, target);
      onChange((current) => [
        ...current.filter(({ id }) => id !== created.id),
        created,
      ]);
      setAdding(false);
    } catch (cause) {
      setError(errorMessage(cause, "Could not update links."));
    }
  }

  async function unlink(link: InboundEmailLink) {
    setWorkingId(link.id);
    setError(undefined);
    try {
      await api.inbox.unlink(emailId, link.id);
      onChange((current) => current.filter(({ id }) => id !== link.id));
    } catch (cause) {
      setError(errorMessage(cause, "Could not update links."));
    } finally {
      setWorkingId(undefined);
    }
  }

  if (!editable && links.length === 0) return null;
  return (
    <section aria-label="Links" className="emailLinks">
      <div className="emailLinksHeader">
        <h3 className="emailLinksTitle">
          <Icon name="link" size={16} />
          Linked to
        </h3>
        {editable && !adding && (
          <Button
            icon="add"
            onClick={() => setAdding(true)}
            size="sm"
            variant="ghost"
          >
            Link
          </Button>
        )}
      </div>
      {error && <Toast tone="danger">{error}</Toast>}
      {links.length > 0 ? (
        <ul className="emailLinkList">
          {links.map((link) => (
            <EmailLinkChip
              disabled={Boolean(workingId)}
              editable={editable}
              key={link.id}
              link={link}
              onNavigate={onNavigate}
              onUnlink={() => void unlink(link)}
              working={workingId === link.id}
            />
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="emailLinksEmpty">
            {canAccessFinance
              ? "Link this email to a library folder, equipment, or a finance transaction to keep it with related records."
              : "Link this email to a library folder or equipment to keep it with related records."}
          </p>
        )
      )}
      {adding && (
        <AddLinkPanel
          canAccessFinance={canAccessFinance}
          links={links}
          onCancel={() => setAdding(false)}
          onLink={link}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

function EmailLinkChip({
  disabled,
  editable,
  link,
  onNavigate,
  onUnlink,
  working,
}: {
  /** One unlink at a time, so each chip's busy state stays accurate. */
  disabled: boolean;
  editable: boolean;
  link: InboundEmailLink;
  onNavigate: (pathname: string) => void;
  onUnlink: () => void;
  working: boolean;
}) {
  const { icon, label, path } = describeEmailLink(link);
  return (
    <li className="emailLinkChip">
      <AppLink className="emailLinkTarget" href={path} onNavigate={onNavigate}>
        <Icon name={icon} size={16} />
        <span className="truncate">{label}</span>
      </AppLink>
      {editable && (
        <Button
          aria-label={`Unlink ${label}`}
          busy={working}
          className="emailLinkRemove"
          disabled={disabled}
          icon="close"
          iconOnly
          onClick={onUnlink}
          size="sm"
          variant="ghost"
        />
      )}
    </li>
  );
}

function AddLinkPanel({
  canAccessFinance,
  links,
  onCancel,
  onLink,
  onNavigate,
}: {
  canAccessFinance: boolean;
  links: InboundEmailLink[];
  onCancel: () => void;
  onLink: (target: InboundEmailLinkTarget) => Promise<void>;
  onNavigate: (pathname: string) => void;
}) {
  const [tab, setTab] = useState<LinkTab>("folder");
  const linkedIds = new Set(links.map(({ targetId }) => targetId));
  const tabs: Array<{ icon: IconName; label: string; value: LinkTab }> = [
    { icon: "folder", label: "Library folder", value: "folder" },
    { icon: "equipment", label: "Equipment", value: "equipment" },
    ...(canAccessFinance
      ? [
          {
            icon: "finance" as const,
            label: "Transaction",
            value: "transaction" as const,
          },
        ]
      : []),
  ];
  return (
    <div className="emailLinkPanel">
      <div className="emailLinkPanelHeader">
        <nav aria-label="Link to" className="segmented">
          {tabs.map((option) => (
            <button
              aria-pressed={tab === option.value}
              key={option.value}
              onClick={() => setTab(option.value)}
              type="button"
            >
              <Icon name={option.icon} size={16} />
              {option.label}
            </button>
          ))}
        </nav>
        <Button icon="close" onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
      {tab !== "transaction" && (
        <TargetPicker
          key={tab}
          kind={tab === "folder" ? folderPicker : equipmentPicker}
          linkedIds={linkedIds}
          onLink={onLink}
          onNavigate={onNavigate}
        />
      )}
      {tab === "transaction" && (
        <TransactionPicker linkedIds={linkedIds} onLink={onLink} />
      )}
    </div>
  );
}

interface PickerKind {
  allLinked: string;
  empty: string;
  icon: IconName;
  label: string;
  load: () => Promise<{ id: string; label: string }[]>;
  loadFailed: string;
  loading: string;
  open: string;
  path: () => string;
  placeholder: string;
  targetType: "equipment" | "library_folder";
}

const equipmentPicker: PickerKind = {
  allLinked: "This email is already linked to all of your equipment.",
  empty: "Your organization hasn’t added any equipment yet.",
  icon: "equipment",
  label: "Equipment",
  load: async () =>
    (await api.equipment.list()).equipment.map((item) => ({
      id: item.id,
      label: `${equipmentTypeLabel(item.type)}: ${equipmentName(item)}${
        item.serialNumber ? ` · ${item.serialNumber}` : ""
      }${item.assignee ? ` (${item.assignee.name})` : ""}`,
    })),
  loadFailed: "Could not load equipment.",
  loading: "Loading equipment…",
  open: "Open Equipment",
  path: equipmentPath,
  placeholder: "Choose equipment…",
  targetType: "equipment",
};

const folderPicker: PickerKind = {
  allLinked: "This email is already linked to every folder.",
  empty: "Your library doesn’t have any folders yet.",
  icon: "folderAdd",
  label: "Folder",
  load: async () =>
    (await api.libraryFolders.list()).map(({ id, name }) => ({
      id,
      label: name,
    })),
  loadFailed: "Could not load folders.",
  loading: "Loading folders…",
  open: "Open the Library",
  path: libraryPath,
  placeholder: "Choose a folder…",
  targetType: "library_folder",
};

/** Links the email to one equipment item or library folder. */
function TargetPicker({
  kind,
  linkedIds,
  onLink,
  onNavigate,
}: {
  kind: PickerKind;
  linkedIds: Set<string>;
  onLink: (target: InboundEmailLinkTarget) => Promise<void>;
  onNavigate: (pathname: string) => void;
}) {
  const { data: options, error } = useLoad(kind.load, kind.loadFailed);
  const [targetId, setTargetId] = useState("");
  const [saving, setSaving] = useState(false);
  const available = options?.filter(({ id }) => !linkedIds.has(id)) ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!targetId) return;
    setSaving(true);
    await onLink({ targetId, targetType: kind.targetType });
    setSaving(false);
  }

  if (error) return <p className="fieldError">{error}</p>;
  if (!options) return <p className="emailLinksEmpty">{kind.loading}</p>;
  if (available.length === 0) {
    return (
      <div className="emailLinkPickerEmpty">
        <p className="emailLinksEmpty">
          {options.length ? kind.allLinked : kind.empty}
        </p>
        <Button
          icon={kind.icon}
          onClick={() => onNavigate(kind.path())}
          size="sm"
        >
          {kind.open}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="emailLinkFolderForm"
      onSubmit={(event) => void submit(event)}
    >
      <Select
        aria-label={kind.label}
        className="inputSm"
        onChange={(event) => setTargetId(event.target.value)}
        value={targetId}
      >
        <option value="">{kind.placeholder}</option>
        {available.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      <Button
        busy={saving}
        disabled={!targetId}
        icon="link"
        size="sm"
        type="submit"
        variant="primary"
      >
        Link
      </Button>
    </form>
  );
}

function TransactionPicker({
  linkedIds,
  onLink,
}: {
  linkedIds: Set<string>;
  onLink: (target: InboundEmailLinkTarget) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FinanceTransactionMatch[]>();
  const [savingId, setSavingId] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      api.finance
        .searchTransactions(query)
        .then((results) => {
          if (!active) return;
          setError(undefined);
          setMatches(results);
        })
        .catch((cause: unknown) => {
          if (active)
            setError(errorMessage(cause, "Could not search transactions."));
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  async function choose(transaction: FinanceTransactionMatch) {
    setSavingId(transaction.id);
    await onLink({
      targetId: transaction.id,
      targetType: "finance_transaction",
    });
    setSavingId(undefined);
  }

  return (
    <div className="emailLinkTransactions">
      <input
        aria-label="Search transactions"
        className="input inputSm"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by merchant, name, or amount"
        type="search"
        value={query}
      />
      {error && <p className="fieldError">{error}</p>}
      {matches && matches.length === 0 && (
        <p className="emailLinksEmpty">No matching transactions.</p>
      )}
      {matches && matches.length > 0 && (
        <ul className="rowList emailLinkMatches">
          {matches.map((transaction) => {
            const linked = linkedIds.has(transaction.id);
            return (
              <li key={transaction.id}>
                <button
                  className={cx(
                    "row emailLinkMatch",
                    linked && "emailLinkMatchLinked",
                  )}
                  disabled={linked || Boolean(savingId)}
                  onClick={() => void choose(transaction)}
                  type="button"
                >
                  <span className="emailLinkMatchDate">
                    {formatTransactionDate(transaction.transactionDate)}
                  </span>
                  <span className="rowMain">
                    <span className="rowTitle truncate">
                      {transaction.merchantName ?? transaction.name}
                    </span>
                    <span className="rowMeta truncate">
                      {linked ? "Already linked" : transaction.accountName}
                    </span>
                  </span>
                  <span className="emailLinkMatchAmount">
                    {savingId === transaction.id ? (
                      <span aria-hidden="true" className="spinner" />
                    ) : (
                      formatMoney(-transaction.amount, transaction.currencyCode)
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
