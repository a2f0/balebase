import {
  Badge,
  type BadgeTone,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Field,
  Icon,
  PageSection,
  Select,
  Toast,
} from "@balebase/ui/react";
import type {
  AuditDefinition,
  AuditIssue,
  AuditIssueUpdate,
  AuditTemplateItem,
} from "@balebase/validators/audits";
import type { Person } from "@balebase/validators/fields";
import {
  issueImageProblem,
  issueImageTypes,
  maxIssueImages,
} from "@balebase/validators/issueRules";
import type { IssueInput } from "@balebase/validators/issues";
import { useEffect, useMemo, useState } from "react";
import { IssueFields } from "../issues/IssueForm";
import { ApiDownload } from "../shared/ApiDownload";
import { ApiImage } from "../shared/ApiImage";
import { api } from "../shared/apiClient";
import { errorMessage } from "../shared/errors";
import { formatDateTime, formatLabel } from "../shared/labels";
import { useAction } from "../shared/useAction";
import {
  appendIssueImageSelection,
  createIssueWithImages,
  issueImageSelectionKey,
  uploadIssueImagesSequentially,
} from "./auditIssueImages";
import { auditItems } from "./auditProgress";

const priorityTones: Record<string, BadgeTone> = {
  critical: "danger",
  high: "danger",
  low: "neutral",
  medium: "warning",
};

/** The audit's issues, with a form to raise one against any checklist item. */
export function AuditIssuePanel({
  auditId,
  definition,
  issues,
  members,
  onChange,
  responses,
}: {
  auditId: string;
  definition: AuditDefinition;
  issues: AuditIssue[];
  members: Person[];
  onChange: () => Promise<void>;
  responses: Record<string, string>;
}) {
  const items = useMemo(() => auditItems(definition), [definition]);
  const [showForm, setShowForm] = useState(false);
  const [issueError, setIssueError] = useState<string>();
  return (
    <PageSection
      actions={
        <Button
          aria-expanded={showForm}
          icon={showForm ? "close" : "add"}
          onClick={() => setShowForm((current) => !current)}
          variant={showForm ? "ghost" : "secondary"}
        >
          {showForm ? "Cancel" : "Raise issue"}
        </Button>
      }
      description="Track follow-up work discovered during this audit."
      title="Issues"
    >
      {issueError && <Toast tone="danger">{issueError}</Toast>}
      {showForm && (
        <AuditIssueForm
          auditId={auditId}
          items={items}
          members={members}
          onCreated={async (warning) => {
            setShowForm(false);
            setIssueError(warning);
            await onChange();
          }}
          responses={responses}
        />
      )}
      {(issues.length > 0 || !showForm) && (
        <AuditIssueList
          issues={issues}
          members={members}
          onChange={onChange}
          onError={setIssueError}
        />
      )}
    </PageSection>
  );
}

function AuditIssueForm({
  auditId,
  items,
  members,
  onCreated,
  responses,
}: {
  auditId: string;
  items: AuditTemplateItem[];
  members: Person[];
  onCreated: (warning?: string) => Promise<void>;
  responses: Record<string, string>;
}) {
  const suggested =
    items.find((item) => responses[item.id] === "fail") ?? items[0];
  const draft = useAuditIssueDraft(auditId, suggested);

  return (
    <Card
      description="Link the issue to a checklist item and assign follow-up."
      footer={
        <Button
          busy={draft.busy}
          className="runIssueSubmit"
          disabled={!draft.itemId || !draft.input.title.trim()}
          icon="add"
          onClick={() => void draft.submit(onCreated)}
          variant="primary"
        >
          {draft.busy ? "Creating…" : "Create issue"}
        </Button>
      }
      title="New issue"
    >
      {draft.error && <Toast tone="danger">{draft.error}</Toast>}
      <Field label="Checklist item">
        <Select
          onChange={(event) => {
            const nextId = event.target.value;
            const title = items.find((item) => item.id === nextId)?.prompt;
            draft.setItemId(nextId);
            draft.setInput((current) => ({ ...current, title: title ?? "" }));
          }}
          value={draft.itemId}
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {responses[item.id] === "fail" ? "Failed · " : ""}
              {item.prompt}
            </option>
          ))}
        </Select>
      </Field>
      <AuditIssueDraftFields draft={draft} members={members} />
    </Card>
  );
}

type AuditIssueDraft = ReturnType<typeof useAuditIssueDraft>;

/** A new audit issue's fields and its create-then-attach-images submission. */
export function useAuditIssueDraft(
  auditId: string,
  item: AuditTemplateItem | undefined,
) {
  const [itemId, setItemId] = useState(item?.id ?? "");
  const [input, setInput] = useState<IssueInput>({
    assignedTo: null,
    description: "",
    priority: "medium",
    title: item?.prompt ?? "",
  });
  const [images, setImages] = useState<File[]>([]);
  const { busy, error, run, setError } = useAction(
    "Could not create the issue.",
  );

  async function submit(onCreated: (warning?: string) => Promise<void>) {
    await run(async () => {
      const warning = await createIssueWithImages(
        auditId,
        { ...input, itemId },
        images,
      );
      await onCreated(warning);
    });
  }

  return {
    busy,
    error,
    images,
    input,
    itemId,
    setError,
    setImages,
    setInput,
    setItemId,
    submit,
  };
}

export function AuditIssueDraftFields({
  draft,
  members,
}: {
  draft: AuditIssueDraft;
  members: Person[];
}) {
  return (
    <>
      <IssueFields
        input={draft.input}
        members={members}
        onChange={draft.setInput}
      />
      <AuditIssueImagePicker
        files={draft.images}
        onChange={draft.setImages}
        onError={draft.setError}
      />
    </>
  );
}

function AuditIssueImagePicker({
  files,
  onChange,
  onError,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  onError: (error: string | undefined) => void;
}) {
  return (
    <fieldset className="fieldset runImagePicker">
      <legend>
        Images <span className="fieldOptional">Optional</span>
      </legend>
      <div className="runImagePickerControls">
        <label
          className={buttonClass({
            className: "runFilePicker",
            size: "sm",
          })}
        >
          <Icon name="image" size={16} />
          Add images
          <input
            accept={issueImageTypes.join(",")}
            className="srOnly"
            multiple
            onChange={(event) => {
              const selected = appendIssueImageSelection(
                files,
                Array.from(event.target.files ?? []),
              );
              if (typeof selected === "string") {
                onError(selected);
                event.target.value = "";
                return;
              }
              onError(undefined);
              onChange(selected);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        <span className="fieldHint">
          Up to 10 JPEG, PNG, GIF, or WebP images; 10 MB each.
        </span>
      </div>
      <SelectedIssueImages
        files={files}
        onRemove={(file) =>
          onChange(files.filter((candidate) => candidate !== file))
        }
      />
    </fieldset>
  );
}

function AuditIssueList({
  issues,
  members,
  onChange,
  onError,
}: {
  issues: AuditIssue[];
  members: Person[];
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  if (!issues.length) {
    return (
      <EmptyState compact icon="issues" title="No issues raised">
        Raise an issue for anything that needs follow-up after this audit.
      </EmptyState>
    );
  }
  return (
    <Card flush>
      <ul className="rowList">
        {issues.map((issue) => (
          <AuditIssueCard
            issue={issue}
            key={issue.id}
            members={members}
            onChange={onChange}
            onError={onError}
          />
        ))}
      </ul>
    </Card>
  );
}

function AuditIssueCard({
  issue,
  members,
  onChange,
  onError,
}: {
  issue: AuditIssue;
  members: Person[];
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const { attach, busy, removeImage, update } = useAuditIssueCardActions({
    issue,
    onChange,
    onError,
  });

  return (
    <li className="row runIssue">
      <div className="rowMain runIssueMain">
        <div className="cluster">
          <Badge tone={priorityTones[issue.priority] ?? "neutral"}>
            {formatLabel(issue.priority)}
          </Badge>
          <Badge dot tone={issue.status === "open" ? "warning" : "success"}>
            {issue.status === "open" ? "Open" : "Resolved"}
          </Badge>
        </div>
        <h3 className="runIssueTitle">{issue.title}</h3>
        <p className="runAttribution">
          Raised by {issue.createdBy.name} · {issue.createdBy.email} ·{" "}
          {formatDateTime(issue.createdAt)}
        </p>
        {issue.description && (
          <p className="runIssueDescription">{issue.description}</p>
        )}
        <AuditIssueThumbnails
          busy={busy}
          issue={issue}
          onAttach={attach}
          onRemove={removeImage}
        />
      </div>
      <AuditIssueCardActions
        busy={busy}
        issue={issue}
        members={members}
        onUpdate={update}
      />
    </li>
  );
}

function AuditIssueCardActions({
  busy,
  issue,
  members,
  onUpdate,
}: {
  busy: boolean;
  issue: AuditIssue;
  members: Person[];
  onUpdate: (update: AuditIssueUpdate) => Promise<void>;
}) {
  const assignedMemberIsMissing =
    Boolean(issue.assignedTo) &&
    !members.some((member) => member.id === issue.assignedTo);
  return (
    <div className="rowActions runIssueActions">
      <label className="runAssignee">
        <span>Assignee</span>
        <Select
          className="inputSm runAssigneeSelect"
          disabled={busy}
          onChange={(event) =>
            void onUpdate({ assignedTo: event.target.value || null })
          }
          value={issue.assignedTo ?? ""}
        >
          <option value="">Unassigned</option>
          {assignedMemberIsMissing && (
            <option disabled value={issue.assignedTo ?? ""}>
              {issue.assigneeName ?? issue.assigneeEmail ?? "Former member"} ·
              no longer a member
            </option>
          )}
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </Select>
      </label>
      <Button
        disabled={busy}
        icon={issue.status === "open" ? "check" : "refresh"}
        onClick={() =>
          void onUpdate({
            status: issue.status === "open" ? "resolved" : "open",
          })
        }
        size="sm"
      >
        {issue.status === "open" ? "Resolve" : "Reopen"}
      </Button>
    </div>
  );
}

function useAuditIssueCardActions({
  issue,
  onChange,
  onError,
}: {
  issue: AuditIssue;
  onChange: () => Promise<void>;
  onError: (error: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);

  // Errors go to the run page's single toast rather than useAction's state.
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    onError(undefined);
    try {
      await action();
      await onChange();
    } catch (cause) {
      onError(errorMessage(cause, "Could not update the issue."));
    } finally {
      setBusy(false);
    }
  }

  return {
    attach: async (files: File[]) => {
      const problem = issueImageProblem(
        files,
        maxIssueImages - issue.images.length,
      );
      if (problem) {
        onError(problem);
        return;
      }
      await run(async () => {
        const [failure] = await uploadIssueImagesSequentially(issue.id, files);
        if (failure !== undefined)
          onError(errorMessage(failure, "Could not update audit."));
      });
    },
    busy,
    removeImage: (imageId: string) =>
      run(() => api.audits.deleteIssueImage(issue.id, imageId)),
    update: (update: AuditIssueUpdate) =>
      run(() => api.audits.updateIssue(issue.id, update)),
  };
}

function AuditIssueThumbnails({
  busy,
  issue,
  onAttach,
  onRemove,
}: {
  busy: boolean;
  issue: AuditIssue;
  onAttach: (files: File[]) => Promise<void>;
  onRemove: (imageId: string) => Promise<void>;
}) {
  return (
    <div className="runIssueImages">
      {issue.images.length > 0 && (
        <ul className="runThumbs">
          {issue.images.map((image) => (
            <li className="runThumb" key={image.id}>
              <ApiDownload
                plain
                filename={image.filename}
                className="runThumbLink"
                href={api.audits.issueImageUrl(issue.id, image.id)}
                rel="noreferrer"
                target="_blank"
              >
                <ApiImage
                  alt={image.filename}
                  className="runThumbImage"
                  decoding="async"
                  loading="lazy"
                  src={api.audits.issueImageUrl(
                    issue.id,
                    image.id,
                    "thumbnail",
                  )}
                />
              </ApiDownload>
              <Button
                aria-label={`Remove ${image.filename}`}
                className="runThumbRemove"
                disabled={busy}
                icon="close"
                iconOnly
                onClick={() => void onRemove(image.id)}
                size="sm"
              />
            </li>
          ))}
        </ul>
      )}
      {issue.images.length < maxIssueImages && (
        <label
          className={buttonClass({
            className: "runFilePicker runAttach",
            size: "sm",
            variant: "ghost",
          })}
        >
          <Icon name="attachment" size={16} />
          Attach images
          <input
            accept={issueImageTypes.join(",")}
            className="srOnly"
            disabled={busy}
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void onAttach(files);
            }}
            type="file"
          />
        </label>
      )}
    </div>
  );
}

function SelectedIssueImages({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (file: File) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="runThumbs">
      {files.map((file) => (
        <SelectedIssueImage
          file={file}
          key={issueImageSelectionKey(file)}
          onRemove={() => onRemove(file)}
        />
      ))}
    </ul>
  );
}

function SelectedIssueImage({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const preview = useObjectUrl(file);
  return (
    <li className="runThumb">
      {preview ? (
        <img alt="" className="runThumbImage" src={preview} />
      ) : (
        <span className="runThumbImage runThumbPlaceholder">
          <Icon name="image" />
        </span>
      )}
      <span className="runThumbName" title={file.name}>
        {file.name}
      </span>
      <Button
        aria-label={`Remove ${file.name}`}
        className="runThumbRemove"
        icon="close"
        iconOnly
        onClick={onRemove}
        size="sm"
      />
    </li>
  );
}

/** A preview URL for a picked file, released when the file leaves the form. */
function useObjectUrl(file: File) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}
