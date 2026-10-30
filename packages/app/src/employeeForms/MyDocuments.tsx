import {
  Badge,
  Banner,
  Button,
  cx,
  EmptyState,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@balebase/ui/react";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import type { WorkspaceOrganization } from "../organizations/organizationState";
import { AppButtonLink, AppLink } from "../shared/AppLink";
import { formatCalendarDate, formatDate } from "../shared/labels";
import {
  myDocumentsPath,
  myRequirementIdForPath,
  myRequirementPath,
  myScreeningIdForPath,
} from "../workspace/workspacePaths";
import { MyRequirementPage } from "./MyRequirementPage";
import {
  type MyRequirementAction,
  MyRequirementActions,
  requirementHint,
  requirementKinds,
  useOwnRequirements,
} from "./myRequirementParts";
import {
  localDate,
  type PersonalGroup,
  personalRequirement,
  type StatusBadge,
} from "./requirementStatus";
import { ScreeningRequest } from "./ScreeningRequest";

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
  const organizationName = organization?.name ?? "Your organization";
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
            organizationName={organizationName}
            requirementId={screeningId}
          />
        </PageBody>
      </Page>
    );
  }
  const requirementId = myRequirementIdForPath(pathname);
  if (requirementId) {
    return (
      <MyRequirementPage
        back={<BackToMyDocuments onNavigate={onNavigate} />}
        key={requirementId}
        onNavigate={onNavigate}
        organizationName={organizationName}
        requirementId={requirementId}
      />
    );
  }
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
  action: MyRequirementAction;
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
                <Icon
                  name={requirementKinds[requirement.kind].icon}
                  size={18}
                />
              </span>
              <div className="myDocumentMain">
                <strong>
                  <AppLink
                    className="myDocumentTitle"
                    href={myRequirementPath(requirement.id)}
                    onNavigate={onNavigate}
                  >
                    {requirement.title}
                  </AppLink>
                </strong>
                <span className="rowMeta">
                  {requirementKinds[requirement.kind].label} ·{" "}
                  {requirement.completedAt
                    ? `Completed ${formatDate(requirement.completedAt)}`
                    : `Due ${formatCalendarDate(requirement.dueDate)}`}
                </span>
                <Hint
                  organizationName={organizationName}
                  requirement={requirement}
                />
              </div>
              <Badge tone={badge.tone}>{badge.label}</Badge>
              <div className="myDocumentActions">
                <MyRequirementActions
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

function Hint({
  organizationName,
  requirement,
}: {
  organizationName: string;
  requirement: EmployeeRequirement;
}) {
  const text = requirementHint(requirement, organizationName);
  return text ? <span className="myDocumentHint">{text}</span> : null;
}

function BackToMyDocuments({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const path = myDocumentsPath();
  return (
    <AppButtonLink
      href={path}
      icon="arrowLeft"
      onNavigate={onNavigate}
      size="sm"
      variant="ghost"
    >
      My documents
    </AppButtonLink>
  );
}
