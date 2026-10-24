import { Button, Card, Field } from "@balebase/ui/react";
import { useEffect, useState } from "react";
import { IssueForm } from "./IssueForm";
import { type OfflineWorkspace, offlineImage } from "./offlineStore";
import { createOfflineIssue } from "./offlineWork";
import { useUnsavedChanges } from "./unsavedChanges";

export function OfflineIssueCreator({
  workspace,
  target,
  onSaved,
}: {
  workspace: OfflineWorkspace;
  target?: { auditId: string; itemId: string };
  onSaved: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useUnsavedChanges(
    dirty || files.length > 0,
    "This issue and its selected photos have not been saved on this device.",
  );
  return (
    <Card title="New offline issue">
      <Field label="Photos (up to 10, 10 MB each)">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          disabled={saving}
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
      </Field>
      <p>{files.map((file) => file.name).join(", ")}</p>
      <IssueForm
        offlineMembers={workspace.members}
        onDirtyChange={setDirty}
        label="Save issue on device"
        onSave={async (input) => {
          setSaving(true);
          try {
            await createOfflineIssue(workspace.key, input, files, target);
            onSaved();
          } finally {
            setSaving(false);
          }
        }}
      />
    </Card>
  );
}

export function OfflineIssueList({
  workspace,
  auditId,
  onNavigate,
}: {
  workspace: OfflineWorkspace;
  auditId?: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="stack">
      {workspace.issues
        .filter((issue) => !auditId || issue.operation.auditId === auditId)
        .map((issue) => (
          <Card key={issue.operation.id} title={issue.operation.title}>
            <p>{issue.operation.description}</p>
            <p>
              {issue.operation.priority} priority ·{" "}
              {workspace.jobs.find((job) => job.id === issue.operation.id)
                ?.status === "synced"
                ? "Issue synced"
                : "Waiting to sync"}
            </p>
            <div className="cluster">
              {issue.images.map((image) => (
                <OfflineImage
                  key={image.id}
                  workspaceKey={workspace.key}
                  id={image.id}
                  filename={image.filename}
                />
              ))}
            </div>
            {workspace.jobs.find((job) => job.id === issue.operation.id)
              ?.status === "synced" && (
              <Button
                onClick={() => onNavigate(`/issues/${issue.operation.id}`)}
              >
                Open synced issue
              </Button>
            )}
          </Card>
        ))}
    </div>
  );
}

function OfflineImage({
  workspaceKey,
  id,
  filename,
}: {
  workspaceKey: string;
  id: string;
  filename: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    void offlineImage(workspaceKey, id)
      .then((blob) => {
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceKey, id]);
  return url ? (
    <img
      src={url}
      alt={filename}
      width={120}
      height={120}
      style={{ objectFit: "cover" }}
    />
  ) : (
    <span>{filename}</span>
  );
}
