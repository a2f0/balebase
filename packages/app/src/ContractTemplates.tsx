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
} from "@balebase/ui/react";
import type {
  ContractTemplate,
  ContractTemplateSummary,
  TemplateVersion,
} from "@balebase/validators/contractTemplates";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppLink } from "./AppLink";
import { api } from "./apiClient";
import { ContractTemplateEditor } from "./ContractTemplateEditor";
import { ContractTemplateMapping } from "./ContractTemplateMapping";
import { formatDate } from "./labels";
import { confirmDiscardChanges } from "./unsavedChanges";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";
import {
  contractPath,
  contractTemplateIdForPath,
  contractTemplatePath,
} from "./workspacePaths";

export function ContractTemplates({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate: (pathname: string) => void;
}) {
  const id = contractTemplateIdForPath(pathname);
  return id ? (
    <TemplatePage id={id} key={id} onNavigate={onNavigate} />
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
  const error = uploader.error ?? list.error;
  const busy = uploader.busy;
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
          <Button busy={busy} icon="add" onClick={choose} variant="primary">
            New template
          </Button>
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
                    {template.currentVersion}
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
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const page = useTemplatePage(id, onNavigate);
  const {
    template,
    error,
    notice,
    setNotice,
    dirty,
    setDirty,
    mapping,
    setMapping,
    loading,
    saved,
    deleting,
    setWorking,
  } = page;
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
        eyebrow={
          template
            ? `Contract template · v${template.version}`
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
        {!template || loading ? (
          !error && <LoadingState label="Loading template…" />
        ) : mapping ? (
          <ContractTemplateMapping
            key={`${id}:${template.version}:mapping`}
            onBusyChange={setWorking}
            onCancel={() => setMapping(false)}
            onCreated={(contractId) => onNavigate(contractPath(contractId))}
            template={template}
          />
        ) : (
          <ContractTemplateEditor
            dirty={dirty}
            disabled={deleting}
            key={`${id}:${template.version}`}
            onBusyChange={setWorking}
            onDirtyChange={setDirty}
            onSaved={saved}
            template={template}
          />
        )}
      </PageBody>
    </Page>
  );
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
  const versionLoad = useAction("Could not load the template version.");
  const deletion = useAction("Could not delete the template.");
  const mounted = useMounted();
  const showTemplate = (template: ContractTemplate) =>
    setData((current) => current && { ...current, template });
  const discard = async () => !dirty || (await confirmDiscardChanges());
  async function selectVersion(version: number) {
    if (!(await discard())) return;
    deletion.setError(undefined);
    await versionLoad.run(async () => {
      showTemplate(await api.contractTemplates.get(id, version));
      setDirty(false);
      setMapping(false);
    });
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
    versionLoad.setError(undefined);
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
              v{version.version}
              {version.version === template.currentVersion ? " · Latest" : ""} ·{" "}
              {formatDate(version.createdAt)}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        disabled={loading || deleting || mapping || working}
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
  };
}
