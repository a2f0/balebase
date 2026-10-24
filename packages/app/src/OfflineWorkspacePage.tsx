import {
  Banner,
  Button,
  Card,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@balebase/ui/react";
import type { AuditTemplate } from "@balebase/validators/audits";
import type { IssueMember } from "@balebase/validators/issues";
import type { OfflineScope } from "@balebase/validators/offline";
import { useEffect, useState } from "react";
import { api } from "./apiClient";
import { guardWorkspaceChange } from "./navigationGuard";
import { OfflineAuditEditor } from "./OfflineAuditEditor";
import { OfflineIssueCreator, OfflineIssueList } from "./OfflineIssues";
import { prepareOfflineDevice } from "./offlinePreparation";
import {
  activateOfflineWorkspace,
  changeOfflineWorkspace,
  type OfflineWorkspace,
  offlineAccessEpoch,
  offlineScopeKey,
} from "./offlineStore";
import { retryOfflineWork, startOfflineAudit } from "./offlineWork";

export interface OfflineIdentity {
  scope: OfflineScope;
  user: IssueMember;
  organizationName: string;
}

export function OfflineWorkspacePage({
  workspace,
  identity,
  online,
  onNavigate,
  storageError,
}: {
  storageError: string | undefined;
  workspace: OfflineWorkspace | undefined;
  identity?: OfflineIdentity | undefined;
  online: boolean;
  onNavigate: (path: string) => void;
}) {
  const [auditId, setAuditId] = useState<string>();
  const [creatingIssue, setCreatingIssue] = useState(false);
  const { error, setError, run } = useOfflineActions();
  const audit = workspace?.audits.find((entry) => entry.id === auditId);
  return (
    <Page>
      <PageHeader
        eyebrow={
          workspace?.organizationName ??
          identity?.organizationName ??
          "On this device"
        }
        title="Offline work"
        description="Download checklists before leaving coverage. Completed audits, issues, and photos sync while the app is open and connected."
        actions={
          <Button onClick={() => onNavigate("/audits")} disabled={!online}>
            Back to audits
          </Button>
        }
      />
      <PageBody>
        {(error || storageError) && (
          <Banner tone="danger">{error || storageError}</Banner>
        )}
        <Banner>
          {online ? "Connected" : "Offline"} ·{" "}
          {workspace?.user.email ?? identity?.user.email}. Saved work stays on
          this device until synced. Keep this browser's data to retain it.
        </Banner>
        {!identity && (
          <Banner>
            Local work only. Reconnect and sign in to the original account and
            organization to sync.
          </Banner>
        )}
        {workspace && (
          <OfflineSyncStatus
            workspace={workspace}
            onRetry={() => void run(() => retryOfflineWork(workspace.key))}
          />
        )}
        {audit && workspace ? (
          <OfflineAuditEditor
            key={audit.id}
            audit={audit}
            workspace={workspace}
            onBack={() => setAuditId(undefined)}
          />
        ) : (
          <>
            {identity && online && (
              <OfflineDownloads
                key={offlineScopeKey(identity.scope)}
                identity={identity}
                workspace={workspace}
                onError={setError}
              />
            )}
            <DownloadedChecklists
              workspace={workspace}
              onStart={guardWorkspaceChange(async (key, template) => {
                await run(async () =>
                  setAuditId(await startOfflineAudit(key, template)),
                );
              })}
            />
            {workspace && (
              <PageSection title="Audits on this device">
                {workspace.audits.map((entry) => (
                  <Button
                    key={entry.id}
                    onClick={guardWorkspaceChange(async () =>
                      setAuditId(entry.id),
                    )}
                  >
                    {entry.template.name} ·{" "}
                    {new Date(entry.startedAt).toLocaleString()} ·{" "}
                    {entry.queued ? "Completed" : "Draft"}
                  </Button>
                ))}
              </PageSection>
            )}
            {workspace && (
              <PageSection
                title="Issues on this device"
                actions={
                  <Button
                    onClick={guardWorkspaceChange(async () =>
                      setCreatingIssue(!creatingIssue),
                    )}
                  >
                    New offline issue
                  </Button>
                }
              >
                {creatingIssue && (
                  <OfflineIssueCreator
                    workspace={workspace}
                    onSaved={() => setCreatingIssue(false)}
                  />
                )}
                <OfflineIssueList workspace={workspace} />
              </PageSection>
            )}
          </>
        )}
      </PageBody>
    </Page>
  );
}

function useOfflineActions() {
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save offline work.",
      );
    }
  };
  return { error, setError, run };
}

function DownloadedChecklists({
  workspace,
  onStart,
}: {
  workspace: OfflineWorkspace | undefined;
  onStart: (key: string, template: AuditTemplate) => Promise<void>;
}) {
  return (
    <PageSection title="Downloaded checklists">
      {!workspace?.templates.length && (
        <p>No checklists downloaded yet. Connect to download a form.</p>
      )}
      {workspace?.templates.map((template) => (
        <Card key={template.id} title={template.name}>
          <p>
            {template.description} · Version {template.version}
          </p>
          <Button onClick={() => void onStart(workspace.key, template)}>
            Start offline audit
          </Button>
        </Card>
      ))}
    </PageSection>
  );
}

function OfflineSyncStatus({
  workspace,
  onRetry,
}: {
  workspace: OfflineWorkspace;
  onRetry: () => void;
}) {
  const remaining = workspace.jobs.filter((job) => job.status !== "synced");
  const errors = [
    ...new Set(remaining.flatMap((job) => (job.error ? [job.error] : []))),
  ];
  const waiting = remaining.filter((job) =>
    job.dependsOn.some(
      (id) =>
        !workspace.jobs.some(
          (other) => other.id === id && other.status === "synced",
        ),
    ),
  );
  return (
    <Card title="Sync status">
      <p role="status">
        {remaining.length
          ? `${remaining.length} operations waiting to sync`
          : "All queued work synced"}
        . {workspace.audits.filter((audit) => !audit.queued).length} local
        drafts.
      </p>
      {waiting.length > 0 && (
        <p>
          Issues wait for their completed audit; photos wait for their issue.
        </p>
      )}
      {errors.map((error) => (
        <Banner key={error} tone="danger">
          {error}
        </Banner>
      ))}
      {remaining.length > 0 && <Button onClick={onRetry}>Retry sync</Button>}
    </Card>
  );
}

function OfflineDownloads({
  identity,
  workspace,
  onError,
}: {
  identity: OfflineIdentity;
  workspace: OfflineWorkspace | undefined;
  onError: (error: string | undefined) => void;
}) {
  // Capture before requests start; sign-out invalidates late preparations too.
  const [epoch] = useState(offlineAccessEpoch);
  const [templates, setTemplates] = useState<AuditTemplate[]>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api.offline
      .forms(identity.scope)
      .then(async (data) => {
        if (!active) return;
        await prepareOfflineDevice(identity, epoch);
        if (!active) return;
        await changeOfflineWorkspace(
          offlineScopeKey(identity.scope),
          (current) => {
            if (!current) throw new Error("Offline storage is unavailable.");
            current.members = data.members;
            return current;
          },
        );
        setTemplates(data.templates);
      })
      .catch((cause: unknown) => {
        if (active)
          onError(
            cause instanceof Error ? cause.message : "Could not load forms.",
          );
      });
    return () => {
      active = false;
    };
  }, [identity, epoch, onError]);
  async function download(id: string) {
    setBusy(true);
    onError(undefined);
    try {
      const data = await api.offline.forms(identity.scope);
      const template = data.templates.find((entry) => entry.id === id);
      if (!template) throw new Error("This form is no longer available.");
      const key = offlineScopeKey(identity.scope);
      await changeOfflineWorkspace(key, (current) => {
        const saved = current ?? {
          ...identity,
          key,
          templates: [],
          members: [],
          audits: [],
          issues: [],
          jobs: [],
        };
        saved.templates = [
          ...saved.templates.filter((entry) => entry.id !== id),
          template,
        ];
        saved.members = data.members;
        return saved;
      });
      activateOfflineWorkspace(key, epoch);
      await navigator.storage?.persist?.().catch(() => false);
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Could not download the form.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageSection title="Download forms">
      {templates ? (
        templates.map((template) => (
          <div className="cluster" key={template.id}>
            <span>
              {template.name} · v{template.version}
            </span>
            <Button disabled={busy} onClick={() => void download(template.id)}>
              {workspace?.templates.some((saved) => saved.id === template.id)
                ? "Update download"
                : "Download"}
            </Button>
          </div>
        ))
      ) : (
        <LoadingState label="Loading available forms…" />
      )}
    </PageSection>
  );
}
