import {
  Button,
  Card,
  EmptyState,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type {
  ContractDetail,
  ContractSummary as ContractListItem,
} from "@balebase/validators/contracts";
import { useCallback, useRef, useState } from "react";
import { AppLink } from "./AppLink";
import { api } from "./apiClient";
import { ContractEditor } from "./ContractEditor";
import { ContractStatusBadge, ContractSummary } from "./ContractSummary";
import { ContractTemplates } from "./ContractTemplates";
import {
  type ContractFilter,
  contractFilters,
  matchesFilter,
} from "./contractFields";
import { countLabel, formatCalendarDate } from "./labels";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";
import {
  contractIdForPath,
  contractPath,
  contractTemplatePath,
  isWithin,
} from "./workspacePaths";

export function Contracts({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  if (isWithin(pathname, contractTemplatePath()))
    return <ContractTemplates onNavigate={onNavigate} pathname={pathname} />;
  const contractId = contractIdForPath(pathname);
  // Keyed so each page starts fresh and ignores the other's late responses.
  return contractId ? (
    <ContractPage id={contractId} key={contractId} onNavigate={onNavigate} />
  ) : (
    <ContractListPage onNavigate={onNavigate} />
  );
}

function useContractList(onNavigate: (pathname: string) => void) {
  const list = useLoad(
    useCallback(() => api.contracts.list(), []),
    "Could not load contracts.",
  );
  const uploader = useAction("Could not upload the contract.");
  const upload = (file: File) =>
    uploader.run(async () => {
      const created = await api.contracts.upload(file);
      if (!created) throw new Error("Contract not found.");
      onNavigate(contractPath(created.id));
    });
  return {
    contracts: list.data,
    error: uploader.error ?? list.error,
    upload,
    uploading: uploader.busy,
  };
}

function ContractListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { contracts, error, upload, uploading } = useContractList(onNavigate);
  const [filter, setFilter] = useState<ContractFilter>("all");
  const fileInput = useRef<HTMLInputElement>(null);
  const choose = () => fileInput.current?.click();
  const visible = (contracts ?? []).filter(({ status }) =>
    matchesFilter(status, filter),
  );
  return (
    <Page>
      <PageHeader
        actions={
          <>
            <Button onClick={() => onNavigate(contractTemplatePath())}>
              Templates
            </Button>
            <Button
              busy={uploading}
              icon="add"
              onClick={choose}
              variant="primary"
            >
              New contract
            </Button>
          </>
        }
        description="Send documents for signature, track who has signed, and keep the signed copies."
        eyebrow="Records"
        title="Contracts"
      />
      <input
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
        ref={fileInput}
        type="file"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {!contracts ? (
          !error && <LoadingState label="Loading contracts…" />
        ) : contracts.length === 0 ? (
          <EmptyState
            actions={
              <Button
                busy={uploading}
                icon="add"
                onClick={choose}
                variant="primary"
              >
                Upload a PDF
              </Button>
            }
            icon="contract"
            title="No contracts yet"
          >
            Upload a PDF, add signers, and place where each of them signs. They
            get an email link and don’t need an account.
          </EmptyState>
        ) : (
          <PageSection
            actions={
              <span className="sectionCount">
                {countLabel(visible.length, "contract")}
              </span>
            }
            title="All contracts"
          >
            <nav
              aria-label="Contract status"
              className="segmented contractFilters"
            >
              {contractFilters.map((option) => (
                <button
                  aria-pressed={filter === option.value}
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </nav>
            <ContractList contracts={visible} onNavigate={onNavigate} />
          </PageSection>
        )}
      </PageBody>
    </Page>
  );
}

function ContractList({
  contracts,
  onNavigate,
}: {
  contracts: ContractListItem[];
  onNavigate: (pathname: string) => void;
}) {
  if (contracts.length === 0) {
    return (
      <EmptyState compact icon="search" title="No contracts in this view" />
    );
  }
  return (
    <Card flush>
      <ul className="rowList contractList">
        {contracts.map((contract) => {
          const path = contractPath(contract.id);
          return (
            <li key={contract.id}>
              <AppLink
                className="row contractRow"
                href={path}
                onNavigate={onNavigate}
              >
                <span className="iconTile">
                  <Icon name="contract" size={20} />
                </span>
                <span className="rowMain">
                  <span className="rowTitle truncate">{contract.title}</span>
                  <span className="rowMeta truncate">
                    {contractMeta(contract)}
                  </span>
                </span>
                <ContractStatusBadge contract={contract} />
              </AppLink>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ContractPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  // Null when a change answers that the contract was deleted meanwhile.
  const {
    data: contract,
    error,
    setData: setContract,
  } = useLoad<ContractDetail | null>(
    useCallback(() => api.contracts.get(id), [id]),
    "Could not load the contract.",
  );
  return (
    <Page className="contractPageLayout">
      <PageHeader
        actions={contract && <ContractStatusBadge contract={contract} />}
        back={
          <Button
            icon="arrowLeft"
            onClick={() => onNavigate(contractPath())}
            size="sm"
            variant="ghost"
          >
            Contracts
          </Button>
        }
        description={
          contract
            ? `${contract.document.filename}${contract.template ? ` · From ${contract.template.name} v${contract.template.version}` : ""}`
            : undefined
        }
        eyebrow={contract?.status === "draft" ? "Draft contract" : "Contract"}
        title={contract?.title ?? (error ? "Contract unavailable" : "Loading…")}
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {!contract ? (
          !error && <LoadingState label="Loading contract…" />
        ) : contract.status === "draft" ? (
          <ContractEditor
            contract={contract}
            onChanged={setContract}
            onDeleted={() => onNavigate(contractPath())}
          />
        ) : (
          <ContractSummary
            contract={contract}
            onChanged={setContract}
            onNavigate={onNavigate}
          />
        )}
      </PageBody>
    </Page>
  );
}

function contractMeta(contract: ContractListItem) {
  const parts = [
    contract.signerCount
      ? `${contract.signedCount} of ${countLabel(contract.signerCount, "signer")} signed`
      : "No signers yet",
  ];
  if (contract.dueDate)
    parts.push(`due ${formatCalendarDate(contract.dueDate)}`);
  if (contract.senderName) parts.push(`from ${contract.senderName}`);
  return parts.join(" · ");
}
