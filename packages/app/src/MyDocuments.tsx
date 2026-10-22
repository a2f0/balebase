import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  cx,
  EmptyState,
  Icon,
  type IconName,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type {
  EmployeeRequirement,
  EmployeeRequirementKind,
} from "@balebase/validators/employeeForms";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "./apiClient";
import {
  downloadEmployeeForm,
  downloadScreeningConsent,
} from "./employeeFormDownloads";
import type { WorkspaceOrganization } from "./organizationState";
import {
  formatDueDate,
  formatTimestamp,
  localDate,
  type PersonalGroup,
  personalRequirement,
  type StatusBadge,
} from "./requirementStatus";
import { ScreeningRequest, screeningProgress } from "./ScreeningRequest";
import {
  handleNavigation,
  myDocumentsPath,
  myScreeningIdForPath,
} from "./workspacePaths";

type Action = (work: () => Promise<unknown>, success: string) => Promise<void>;

const kinds: Record<
  EmployeeRequirementKind,
  { icon: IconName; label: string }
> = {
  background_check: { icon: "security", label: "Background check" },
  credit_check: { icon: "finance", label: "Credit check" },
  form: { icon: "document", label: "Form" },
};

/**
 * The signed-in person's own side of the organization's requests: what they
 * still need to do, what the organization is working on, and what's done.
 * People complete their forms and background checks here, not in People.
 */
export function MyDocuments({
  onNavigate,
  organization,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  organization: WorkspaceOrganization | undefined;
  pathname: string;
}) {
  const screeningId = myScreeningIdForPath(pathname);
  if (screeningId) {
    return (
      <Page>
        <PageHeader
          back={<BackToMyDocuments onNavigate={onNavigate} />}
          eyebrow="My documents"
          title="Your background check"
        />
        <PageBody>
          <ScreeningRequest
            back={myDocumentsPath()}
            key={screeningId}
            onNavigate={onNavigate}
            organizationName={organization?.name ?? "Your organization"}
            requirementId={screeningId}
          />
        </PageBody>
      </Page>
    );
  }
  const organizationName = organization?.name ?? "Your organization";
  return (
    <Page>
      <PageHeader
        description={`Forms and checks ${organizationName} asked you for, and where each one stands.`}
        eyebrow={organizationName}
        title="My documents"
      />
      <PageBody>
        <Dashboard
          onNavigate={onNavigate}
          organizationName={organizationName}
        />
      </PageBody>
    </Page>
  );
}

function Dashboard({
  onNavigate,
  organizationName,
}: {
  onNavigate: (pathname: string) => void;
  organizationName: string;
}) {
  const { action, busy, error, loading, notice, reload, requirements } =
    useOwnRequirements();
  if (!requirements) {
    return loading ? (
      <LoadingState label="Loading your documents…" />
    ) : (
      <Banner
        actions={
          <Button onClick={() => void reload()} size="sm">
            Try again
          </Button>
        }
        tone="danger"
      >
        {error ?? "Could not load your documents."}
      </Banner>
    );
  }
  const today = localDate();
  const items = requirements.map((requirement) => ({
    requirement,
    ...personalRequirement(requirement, today),
  }));
  const inGroup = (group: PersonalGroup) =>
    items.filter((item) => item.group === group);
  const props = { action, busy, onNavigate, organizationName };
  return (
    <div className="stack stackLg">
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {items.length === 0 ? (
        <EmptyState icon="document" title="Nothing requested yet">
          When {organizationName} asks you for a form or a background check, it
          shows up here.
        </EmptyState>
      ) : (
        <>
          <Summary
            counts={{
              done: inGroup("done").length,
              overdue: inGroup("todo").filter(
                (item) => item.requirement.dueDate < today,
              ).length,
              todo: inGroup("todo").length,
              waiting: inGroup("waiting").length,
            }}
            organizationName={organizationName}
          />
          <Group
            {...props}
            empty="You’re all caught up."
            items={inGroup("todo")}
            title="To do"
          />
          <Group
            {...props}
            description={`You’ve done your part. ${organizationName} finishes these.`}
            items={inGroup("waiting")}
            title={`With ${organizationName}`}
          />
          <Group {...props} items={inGroup("done")} title="Done" />
        </>
      )}
    </div>
  );
}

function useOwnRequirements() {
  const [requirements, setRequirements] = useState<EmployeeRequirement[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRequirements(
        (await api.employeeForms.list({ own: true })).requirements,
      );
      setError(undefined);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const action: Action = async (work, success) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
      await reload();
      setNotice(success);
    } catch (cause) {
      const message = messageFrom(cause);
      await reload();
      setError(message);
    } finally {
      setBusy(false);
    }
  };
  return { action, busy, error, loading, notice, reload, requirements };
}

function Summary({
  counts,
  organizationName,
}: {
  counts: Record<"done" | "overdue" | "todo" | "waiting", number>;
  organizationName: string;
}) {
  const stats = [
    { label: "To do", value: counts.todo },
    { alert: counts.overdue > 0, label: "Overdue", value: counts.overdue },
    { label: `With ${organizationName}`, value: counts.waiting },
    { label: "Done", value: counts.done },
  ];
  return (
    <dl className="gridAuto myDocumentsSummary">
      {stats.map((stat) => (
        <div
          className={cx(
            "myDocumentsStat",
            stat.alert && "myDocumentsStatAlert",
          )}
          key={stat.label}
        >
          <dt>{stat.label}</dt>
          <dd>{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface GroupItem {
  badge: StatusBadge;
  requirement: EmployeeRequirement;
}

function Group({
  action,
  busy,
  description,
  empty,
  items,
  onNavigate,
  organizationName,
  title,
}: {
  action: Action;
  busy: boolean;
  description?: string;
  /** Shown when nothing is in the group; without it, an empty group hides. */
  empty?: string;
  items: GroupItem[];
  onNavigate: (pathname: string) => void;
  organizationName: string;
  title: string;
}) {
  if (!items.length && !empty) return null;
  return (
    <PageSection description={description} title={title}>
      {items.length ? (
        <ul className="myDocumentList">
          {items.map(({ badge, requirement }) => (
            <li className="myDocument" key={requirement.id}>
              <span aria-hidden="true" className="myDocumentIcon">
                <Icon name={kinds[requirement.kind].icon} size={18} />
              </span>
              <div className="myDocumentMain">
                <strong>{requirement.title}</strong>
                <span className="rowMeta">
                  {kinds[requirement.kind].label} ·{" "}
                  {requirement.completedAt
                    ? `Completed ${formatTimestamp(requirement.completedAt)}`
                    : `Due ${formatDueDate(requirement.dueDate)}`}
                </span>
                <Hint
                  organizationName={organizationName}
                  requirement={requirement}
                />
              </div>
              <Badge tone={badge.tone}>{badge.label}</Badge>
              <div className="myDocumentActions">
                <Actions
                  action={action}
                  busy={busy}
                  onNavigate={onNavigate}
                  requirement={requirement}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </PageSection>
  );
}

/** One line on what happens next, when the badge alone doesn't say. */
function Hint({
  organizationName,
  requirement,
}: {
  organizationName: string;
  requirement: EmployeeRequirement;
}) {
  const text = hintFor(requirement, organizationName);
  return text ? <span className="myDocumentHint">{text}</span> : null;
}

function hintFor(requirement: EmployeeRequirement, organizationName: string) {
  if (requirement.checkrReportStatus && !requirement.canSubmitCheckr) {
    return screeningProgress(requirement, organizationName);
  }
  if (requirement.status === "complete") return undefined;
  if (requirement.kind === "form") {
    return requirement.status === "pending"
      ? "Upload a PDF, JPEG, or PNG."
      : `${organizationName} is reviewing ${requirement.documentFilename ?? "your file"}.`;
  }
  if (requirement.kind === "credit_check") {
    return `${organizationName} runs this check and contacts you if it needs anything.`;
  }
  if (requirement.canSubmitCheckr) {
    const location = [
      requirement.checkrWorkLocation?.city,
      requirement.checkrWorkLocation?.state,
    ]
      .filter(Boolean)
      .join(", ");
    return `Read the disclosures, enter your details, and sign. Balebase sends them to Checkr for work in ${location}.`;
  }
  if (!requirement.checkrReportStatus && requirement.status === "pending") {
    return `${organizationName} sends you this check when it’s ready.`;
  }
  return undefined;
}

function Actions({
  action,
  busy,
  onNavigate,
  requirement,
}: {
  action: Action;
  busy: boolean;
  onNavigate: (pathname: string) => void;
  requirement: EmployeeRequirement;
}) {
  const controls: ReactNode[] = [];
  if (requirement.canSubmitCheckr || requirement.checkrReportStatus) {
    const path = myDocumentsPath(requirement.id);
    controls.push(
      <ButtonLink
        href={path}
        key="screening"
        onClick={(event) => handleNavigation(event, path, onNavigate)}
        size="sm"
        variant="primary"
      >
        {!requirement.canSubmitCheckr
          ? "View screening status"
          : requirement.checkrSubmitting
            ? "Finish background check"
            : "Start background check"}
      </ButtonLink>,
    );
  }
  if (requirement.kind === "form" && requirement.status !== "complete") {
    controls.push(
      <UploadButton
        busy={busy}
        key="upload"
        label={requirement.hasDocument ? "Replace file" : "Upload file"}
        onFile={(file) =>
          action(
            () => api.employeeForms.upload(requirement.id, file),
            `${requirement.title} sent.`,
          )
        }
        primary={requirement.status === "pending"}
      />,
    );
  }
  if (requirement.hasDocument) {
    controls.push(
      <Button
        disabled={busy}
        icon="download"
        key="document"
        onClick={() =>
          void action(
            () =>
              downloadEmployeeForm(
                requirement.id,
                requirement.documentFilename ?? "form",
              ),
            "Download started.",
          )
        }
        size="sm"
        variant="ghost"
      >
        {requirement.documentFilename ?? "Your file"}
      </Button>,
    );
  }
  if (requirement.hasCheckrConsent) {
    controls.push(
      <Button
        disabled={busy}
        icon="download"
        key="consent"
        onClick={() =>
          void action(
            () => downloadScreeningConsent(requirement.id),
            "Download started.",
          )
        }
        size="sm"
        variant="ghost"
      >
        Signed authorization
      </Button>,
    );
  }
  return <>{controls}</>;
}

function UploadButton({
  busy,
  label,
  onFile,
  primary,
}: {
  busy: boolean;
  label: string;
  onFile: (file: File) => Promise<void>;
  primary: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        aria-label={label}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onFile(file);
          event.target.value = "";
        }}
        ref={input}
        type="file"
      />
      <Button
        disabled={busy}
        icon="upload"
        onClick={() => input.current?.click()}
        size="sm"
        variant={primary ? "primary" : "secondary"}
      >
        {label}
      </Button>
    </>
  );
}

function BackToMyDocuments({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const path = myDocumentsPath();
  return (
    <ButtonLink
      href={path}
      icon="arrowLeft"
      onClick={(event) => handleNavigation(event, path, onNavigate)}
      size="sm"
      variant="ghost"
    >
      My documents
    </ButtonLink>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update your documents.";
}
