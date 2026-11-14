import {
  Button,
  Card,
  confirmDialog,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  Select,
  Toast,
  useSectionTabs,
} from "@balebase/ui/react";
import type {
  ContractTemplate,
  ContractTemplateSummary,
  TemplateVersion,
} from "@balebase/validators/contractTemplates";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ActivityFeed } from "../activity/ActivityFeed";
import { AppLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { formatDate } from "../shared/labels";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { confirmDiscardChanges } from "../workspace/unsavedChanges";
import {
  contractPath,
  contractTemplateIdForPath,
  contractTemplatePath,
} from "../workspace/workspacePaths";
import { ContractTemplateEditor } from "./ContractTemplateEditor";
import { ContractTemplateMapping } from "./ContractTemplateMapping";
import { newAuthoredDraft } from "./contractAuthoringState";
import { writtenTemplateInput } from "./contractTemplateAuthoring";
import { useTemplateRequest } from "./contractTemplateState";

export function ContractTemplates({
  pathname,
  onNavigate,
  canPublish = false,
}: {
  pathname: string;
  onNavigate: (pathname: string) => void;
  canPublish?: boolean;
}) {
  const id = contractTemplateIdForPath(pathname);
  return id ? (
    <TemplatePage
      canPublish={canPublish}
      id={id}
      key={id}
      onNavigate={onNavigate}
    />
  ) : (
    <TemplateList onNavigate={onNavigate} />
  );
}

function TemplateList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const list = useLoad(
    useCallback(() => api.contractTemplates.list(), []),
    "Could not load contract templates.",
  );
  const templates = list.data;
  const uploader = useAction("Could not upload the template.");
  const writer = useTemplateRequest<ContractTemplate>((template) =>
    onNavigate(contractTemplatePath(template.id)),
  );
  const error = writer.error ?? uploader.error ?? list.error;
  const busy = writer.busy || uploader.busy;
  function writeTemplate() {
    writer.start(async () => {
      const created = await api.contractTemplates.createAuthored(
        writtenTemplateInput(newAuthoredDraft(), "Untitled template"),
      );
      if (!created) throw new Error("Contract template not found.");
      return created;
    });
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const mounted = useMounted();
  async function upload(file: File) {
    if (uploading.current) return;
    uploading.current = true;
    const uploaded = await uploader.run(async () => {
      const template = await api.contractTemplates.upload(file);
      if (!template) throw new Error("Contract template not found.");
      if (mounted.current) onNavigate(contractTemplatePath(template.id));
    });
    if (!uploaded) uploading.current = false;
  }
  const choose = () => fileInput.current?.click();
  return (
    <Page>
      <PageHeader
        actions={
          <>
            <Button disabled={busy} onClick={writeTemplate}>
              New written template
            </Button>
            <Button busy={busy} icon="add" onClick={choose} variant="primary">
              New PDF template
            </Button>
          </>
        }
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
        description="Place fields once, then map signer roles to people each time you use a template."
        eyebrow="Contracts"
        title="Contract templates"
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
        {!templates ? (
          !error && <LoadingState label="Loading templates…" />
        ) : templates.length === 0 ? (
          <EmptyState
            actions={
              <Button busy={busy} icon="add" onClick={choose} variant="primary">
                Upload a PDF
              </Button>
            }
            icon="contract"
            title="No contract templates yet"
          >
            Upload a document, add signer roles, and draw their fields. Saved
            versions stay available for future contracts.
          </EmptyState>
        ) : (
          <TemplateRows onNavigate={onNavigate} templates={templates} />
        )}
      </PageBody>
    </Page>
  );
}

function TemplateRows({
  onNavigate,
  templates,
}: {
  onNavigate: (pathname: string) => void;
  templates: ContractTemplateSummary[];
}) {
  return (
    <Card flush>
      <ul className="rowList contractList">
        {templates.map((template) => {
          const path = contractTemplatePath(template.id);
          return (
            <li key={template.id}>
              <AppLink
                className="row contractRow"
                href={path}
                onNavigate={onNavigate}
              >
                <span className="iconTile">
                  <Icon name="contract" size={20} />
                </span>
                <span className="rowMain">
                  <span className="rowTitle truncate">{template.name}</span>
                  <span className="rowMeta truncate">
                    {template.description || "Reusable contract"} · v
                    {template.currentVersion} ·{" "}
                    {template.format === "markdown" ? "Written" : "PDF"} ·{" "}
                    {template.status}
                  </span>
                </span>
                <Icon name="chevronRight" size={16} />
              </AppLink>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function TemplatePage({
  id,
  onNavigate,
  canPublish,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
  canPublish: boolean;
}) {
  const { page, sections } = useTemplateSections(id, onNavigate);
  const { template, error, notice, setNotice, loading } = page;
  return (
    <Page className="contractPageLayout">
      <PageHeader
        actions={template && <TemplateActions page={page} />}
        back={
          <Button
            icon="arrowLeft"
            onClick={() => {
              onNavigate(contractTemplatePath());
            }}
            size="sm"
            variant="ghost"
          >
            Templates
          </Button>
        }
        description={template?.document.filename}
        tabs={template && sections.tabs}
        tabsKind="panels"
        tabsLabel="Template sections"
        eyebrow={
          template
            ? `${template.authoring ? "Written" : "PDF"} template · v${template.version} · ${template.status} · Latest: ${template.currentStatus}`
            : "Contract template"
        }
        title={template?.name ?? (error ? "Template unavailable" : "Loading…")}
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && (
          <Toast
            actions={
              <Button
                aria-label="Dismiss notification"
                icon="close"
                iconOnly
                onClick={() => setNotice(undefined)}
                size="sm"
                variant="ghost"
              />
            }
            tone="success"
          >
            {notice}
          </Toast>
        )}
        {loading && <LoadingState label="Loading template version…" />}
        {!template
          ? !error && <LoadingState label="Loading template…" />
          : sections.panel(
              "template",
              <TemplateWork
                canPublish={canPublish}
                id={id}
                onNavigate={onNavigate}
                page={page}
              />,
            )}
        {template &&
          sections.panel(
            "activity",
            <ActivityFeed
              refreshKey={template.currentVersion}
              source={{ id, type: "contract_template" }}
            />,
          )}
      </PageBody>
    </Page>
  );
}

/** The open version's editor, or the mapping that starts a contract from it. */
function TemplateWork({
  id,
  onNavigate,
  page,
  canPublish,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
  page: TemplatePageState;
  canPublish: boolean;
}) {
  const {
    deleting,
    dirty,
    mapping,
    saved,
    setDirty,
    setMapping,
    setWorking,
    template,
  } = page;
  if (!template) return null;
  return mapping ? (
    <ContractTemplateMapping
      key={`${id}:${template.version}:mapping`}
      onBusyChange={setWorking}
      onCancel={() => setMapping(false)}
      onCreated={(contractId) => onNavigate(contractPath(contractId))}
      template={template}
    />
  ) : (
    <ContractTemplateEditor
      canPublish={canPublish}
      dirty={dirty}
      disabled={deleting || page.loading}
      key={`${id}:${template.version}`}
      onBusyChange={setWorking}
      onDirtyChange={setDirty}
      onSaved={saved}
      template={template}
    />
  );
}

/** The template and its history as tabs; starting a contract shows the template. */
function useTemplateSections(
  id: string,
  onNavigate: (pathname: string) => void,
) {
  const sections = useSectionTabs([
    { id: "template", label: "Template" },
    { id: "activity", label: "Activity" },
  ] as const);
  const loaded = useTemplatePage(id, onNavigate);
  const page: TemplatePageState = {
    ...loaded,
    setMapping: (value: SetStateAction<boolean>) => {
      if (value === true) sections.select("template");
      loaded.setMapping(value);
    },
  };
  return { page, sections };
}

/** Lets a late response skip navigation once the user has left. */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

type TemplatePageState = ReturnType<typeof useTemplatePage>;
function useTemplatePage(id: string, onNavigate: (pathname: string) => void) {
  const loaded = useLoad(
    useCallback(async () => {
      const [template, versions] = await Promise.all([
        api.contractTemplates.get(id),
        api.contractTemplates.versions(id),
      ]);
      return { template, versions };
    }, [id]),
    "Could not load the contract template.",
  );
  const { setData } = loaded;
  const [notice, setNotice] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [working, setWorking] = useState(false);
  const versionLoad = useTemplateRequest<ContractTemplate>((template) => {
    setData((current) => current && { ...current, template });
    setDirty(false);
    setMapping(false);
  });
  const deletion = useAction("Could not delete the template.");
  const mounted = useMounted();
  const discard = async () => !dirty || (await confirmDiscardChanges());
  async function selectVersion(version: number) {
    if (!(await discard())) return;
    deletion.setError(undefined);
    versionLoad.start(() => api.contractTemplates.get(id, version));
  }
  function saved(value: ContractTemplate) {
    setData(
      (current) =>
        current && {
          template: value,
          versions: [versionSummary(value), ...current.versions],
        },
    );
    setDirty(false);
    setNotice(`Version ${value.version} saved.`);
  }
  async function remove() {
    if (!(await confirmTemplateDeletion())) return;
    await deletion.run(async () => {
      await api.contractTemplates.delete(id);
      if (mounted.current) onNavigate(contractTemplatePath());
    });
  }
  return {
    template: loaded.data?.template,
    versions: loaded.data?.versions ?? [],
    error: deletion.error ?? versionLoad.error ?? loaded.error,
    notice,
    setNotice,
    dirty,
    setDirty,
    mapping,
    setMapping,
    loading: versionLoad.busy,
    deleting: deletion.busy,
    discard,
    selectVersion,
    saved,
    remove,
    working,
    setWorking,
  };
}

function TemplateActions({ page }: { page: TemplatePageState }) {
  const {
    template,
    versions,
    loading,
    deleting,
    mapping,
    setMapping,
    setDirty,
    discard,
    selectVersion,
    remove,
    working,
  } = page;
  if (!template) return null;
  return (
    <>
      <Field label="Version">
        <Select
          disabled={loading || deleting || working}
          onChange={(event) => void selectVersion(Number(event.target.value))}
          value={template.version}
        >
          {versions.map((version) => (
            <option key={version.version} value={version.version}>
              v{version.version} · {version.status}
              {version.version === template.currentVersion ? " · Latest" : ""} ·{" "}
              {formatDate(version.createdAt)}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        disabled={
          loading ||
          deleting ||
          mapping ||
          working ||
          template.status !== "published" ||
          template.currentStatus !== "published"
        }
        onClick={async () => {
          if (await discard()) {
            setDirty(false);
            setMapping(true);
          }
        }}
        variant="primary"
      >
        Use this version
      </Button>
      {(template.status !== "published" ||
        template.currentStatus !== "published") && (
        <span className="contractHint">
          Publish the latest template and select a published version to create
          contracts.
        </span>
      )}
      <Button
        busy={deleting}
        disabled={loading || working}
        icon="trash"
        onClick={() => void remove()}
        variant="ghost"
      >
        Delete template
      </Button>
    </>
  );
}

function confirmTemplateDeletion() {
  return confirmDialog({
    confirmLabel: "Delete template",
    message: "Contracts already created from it will stay available.",
    title: "Delete this template and all of its versions?",
    tone: "danger",
  });
}

function versionSummary(template: ContractTemplate): TemplateVersion {
  return {
    createdAt: template.createdAt,
    createdByName: template.createdByName,
    name: template.name,
    version: template.version,
    status: template.status,
  };
}
