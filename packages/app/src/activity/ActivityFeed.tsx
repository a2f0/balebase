import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageSection,
} from "@balebase/ui/react";
import type {
  ActivityActor,
  ActivityEvent,
  ActivityResourceType,
} from "@balebase/validators/activity";
import { useCallback } from "react";
import { formatRoles } from "../organizations/organizationState";
import { InfiniteScroll } from "../shared/InfiniteScroll";
import { formatDateTime } from "../shared/labels";
import { useCursorPages } from "../shared/useCursorPages";
import {
  auditRunPath,
  auditTemplatePath,
  billingPath,
  businessPath,
  contractPath,
  contractTemplatePath,
  equipmentPath,
  financeCategoriesPath,
  financeConnectionPath,
  financeTransactionPath,
  issuePath,
  libraryPath,
  organizationAccessPath,
  organizationPeoplePath,
  organizationRequirementPath,
  projectPath,
} from "../workspace/workspacePaths";
import { assigneeLabel, textValue } from "./activityLabels";
import { type ActivitySource, listActivity } from "./activitySource";
import {
  contractActivitySummary,
  requirementActivitySummary,
} from "./contractActivity";
import {
  EquipmentActivityDetails,
  equipmentActivitySummary,
} from "./EquipmentActivity";
import { financeActionLabels, financeActivitySummary } from "./financeActivity";
import { groupActivitySummary } from "./groupActivity";
import { isLibraryActivity, libraryActivitySummary } from "./libraryActivity";
import {
  membershipSummary,
  organizationActionLabels,
  organizationActivitySummary,
} from "./organizationActivity";
import { projectActivitySummary } from "./projectActivity";
import { RecordActivityDetails } from "./RecordActivity";
import {
  actorDetail,
  actorName,
  purgeSummary,
  systemActionLabels,
} from "./systemActivity";

const actionLabels: Record<string, string> = {
  "finance.daily_sync_changed": "changed daily sync",
  "finance.sync_requested": "requested a bank sync",
  "finance.connection_disconnected": "disconnected a bank",
  "finance.transaction_annotated": "updated a transaction annotation",
  "finance.transaction_categorized": "changed the expense category",
  "issue.created": "raised an issue",
  "issue.assigned": "changed the issue assignee",
  "issue.resolved": "resolved an issue",
  "issue.reopened": "reopened an issue",
  "issue.updated": "edited an issue",
  "api_key.created": "created an API key",
  "api_key.revoked": "revoked an API key",
  "audit.answer_changed": "changed an answer",
  "business.created": "added a business",
  "business.deleted": "deleted a business",
  "business.updated": "edited a business",
  "inbox.email_archived": "archived an email",
  "inbox.email_linked": "linked an email",
  "inbox.email_restored": "restored an email",
  "inbox.email_trashed": "moved an email to Trash",
  "inbox.email_unlinked": "unlinked an email",
  "library.file_deleted": "deleted a file",
  "library.file_moved": "moved a file",
  "library.file_uploaded": "uploaded a file",
  "library.folder_created": "created a folder",
  "library.folder_deleted": "deleted a folder",
  "library.folder_renamed": "renamed a folder",
  "audit.completed": "completed the audit",
  "audit.offline_synced": "synced an offline audit",
  "audit.discarded": "discarded the audit",
  "audit.image_removed": "removed an image",
  "audit.image_uploaded": "attached an image",
  "audit.issue_assigned": "changed the issue assignee",
  "audit.issue_created": "raised an issue",
  "audit.issue_reopened": "reopened an issue",
  "audit.issue_resolved": "resolved an issue",
  "audit.reopened": "reopened the audit",
  "audit.started": "started the audit",
  "audit.template_created": "created the form",
  "audit.template_discarded": "discarded the form",
  "audit.template_published": "published the form",
  "audit.template_restored": "restored the form",
  "audit.template_unpublished": "unpublished the form",
  "audit.template_version_saved": "saved a form version",
  "contract.created": "created a contract",
  "contract.deleted": "deleted a contract",
  "contract.sent": "sent a contract for signature",
  "contract.voided": "voided a contract",
  "contract_template.deleted": "deleted a contract template",
  "employee_requirement.assigned": "requested a form or check",
  "employee_requirement.deleted": "removed a request",
  "employee_requirement.document_uploaded": "uploaded a requested form",
  "employee_requirement.due_date_changed": "changed a request's due date",
  "employee_requirement.screening_requested": "requested a background check",
  "employee_requirement.status_changed": "changed a request's status",
  "equipment.assigned": "changed the equipment assignee",
  "equipment.created": "added equipment",
  "equipment.deleted": "deleted equipment",
  "equipment.updated": "edited equipment",
  "organization.group_created": "created a group",
  "organization.group_deleted": "deleted a group",
  "organization.group_updated": "changed a group",
  "organization.member_role_changed": "changed an organization role",
  "organization.member_two_factor_requirement_changed":
    "changed a two-factor requirement",
  "project.created": "created a project",
  "project.deleted": "deleted a project",
  "project.form_disabled": "turned off an audit form",
  "project.form_enabled": "turned on an audit form",
  "project.member_added": "added a project member",
  "project.member_removed": "removed a project member",
  "project.updated": "edited a project",
  ...financeActionLabels,
  ...organizationActionLabels,
  ...systemActionLabels,
};

export function ActivityFeed({
  compact = false,
  onNavigate,
  refreshKey,
  resourceType,
  source,
  title,
}: {
  compact?: boolean;
  onNavigate?: (pathname: string) => void;
  refreshKey?: unknown;
  resourceType?: ActivityResourceType | undefined;
  source?: ActivitySource;
  title?: string;
}) {
  const {
    error,
    generation,
    items,
    loadMore,
    loadingMore,
    nextCursor,
    refreshing,
    reload,
  } = useActivityPage(source, refreshKey, resourceType);
  return (
    <PageSection
      className={compact ? "activityFeedCompact" : undefined}
      actions={
        <Button onClick={reload} size="sm">
          Refresh activity
        </Button>
      }
      title={title ?? (compact ? "Recent activity" : "Activity")}
    >
      {error && <Banner tone="danger">{error}</Banner>}
      {items ? (
        <ActivityList
          compact={compact}
          events={items}
          onNavigate={source ? undefined : onNavigate}
        />
      ) : (
        !error && <LoadingState label="Loading activity…" />
      )}
      {items && nextCursor && (
        <InfiniteScroll
          autoLoad={!error}
          busy={loadingMore}
          cursor={nextCursor}
          disabled={refreshing}
          key={generation}
          onLoadMore={loadMore}
        >
          Load more activity
        </InfiniteScroll>
      )}
    </PageSection>
  );
}

function useActivityPage(
  source: ActivitySource,
  refreshKey: unknown,
  resourceType: ActivityResourceType | undefined,
) {
  const sourceId = source?.id;
  const sourceType = source?.type;
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await listActivity(
        sourceId && sourceType ? { id: sourceId, type: sourceType } : undefined,
        cursor,
        resourceType,
      );
      return { items: page.events, nextCursor: page.nextCursor };
    },
    [sourceId, sourceType, resourceType],
  );
  return useCursorPages(fetchPage, "Could not load activity.", refreshKey);
}

function ActivityList({
  compact,
  events,
  onNavigate,
}: {
  compact: boolean;
  events: ActivityEvent[];
  onNavigate?: ((pathname: string) => void) | undefined;
}) {
  if (!events.length)
    return (
      <EmptyState compact icon="layers" title="No activity yet">
        Saved changes will appear here.
      </EmptyState>
    );
  return (
    <Card flush>
      <ol aria-label="Activity history" className="rowList activityList">
        {events.map((event) =>
          compact ? (
            <CompactActivityRow
              event={event}
              key={event.id}
              onNavigate={onNavigate}
            />
          ) : (
            <ActivityRow event={event} key={event.id} onNavigate={onNavigate} />
          ),
        )}
      </ol>
    </Card>
  );
}

function CompactActivityRow({
  event,
  onNavigate,
}: {
  event: ActivityEvent;
  onNavigate: ((pathname: string) => void) | undefined;
}) {
  const href = activityPath(event);
  return (
    <li className="row activityRow activityRowCompact">
      <div className="activityCompactHeading">
        <p className="activityHeading">
          <strong title={actorDetail(event.actor)}>
            {actorName(event.actor)}
          </strong>
          <ApiKeyAttribution actor={event.actor} />{" "}
          {actionLabels[event.action] ?? event.action}
          {onNavigate && (
            <>
              {" · "}
              {href ? (
                <Button
                  aria-label={`${activityLinkLabel(event)}: ${event.root.label}`}
                  className="activityResource"
                  onClick={() => onNavigate(href)}
                  size="sm"
                  variant="link"
                >
                  {event.root.label}
                </Button>
              ) : (
                event.root.label
              )}
            </>
          )}
          {event.historical && (
            <span className="activityHistorical">
              <Badge>From existing records</Badge>
            </span>
          )}
        </p>
        <time className="activityTime" dateTime={event.occurredAt}>
          {formatDateTime(event.occurredAt)}
        </time>
      </div>
      <details className="activityDisclosure">
        <summary>
          <span className="activitySummary">{activitySummary(event)}</span>
        </summary>
        <div className="activityExpanded">
          <p className="activityMeta">{actorDetail(event.actor)}</p>
          <ActivityDetails event={event} />
        </div>
      </details>
    </li>
  );
}

/** One-line summaries for roots whose events share a format. */
const rootSummaries: Partial<Record<string, (event: ActivityEvent) => string>> =
  {
    api_key: apiKeySummary,
    contract: contractActivitySummary,
    contract_template: contractActivitySummary,
    employee_requirement: requirementActivitySummary,
    equipment: equipmentActivitySummary,
    organization: organizationActivitySummary,
    organization_group: groupActivitySummary,
    organization_invitation: organizationActivitySummary,
    organization_member: memberSummary,
    project: projectActivitySummary,
    user: purgeSummary,
  };

function memberSummary(event: ActivityEvent) {
  if (membershipActions.has(event.action)) return membershipSummary(event);
  const change =
    event.action === "organization.member_two_factor_requirement_changed"
      ? twoFactorSummary(event)
      : `${formatRoles(textValue(event.details.before))} → ${formatRoles(textValue(event.details.after))}`;
  return `${memberLabel(event)} · ${change}`;
}

const membershipActions = new Set([
  "organization.member_joined",
  "organization.member_left",
  "organization.member_removed",
]);

function activitySummary(event: ActivityEvent) {
  const { details } = event;
  // Links are recorded on equipment and transactions too.
  if (isLibraryActivity(event)) return libraryActivitySummary(event);
  if (event.action === "finance.transaction_annotated")
    return "Annotation changes";
  if (event.action === "finance.transaction_categorized") {
    return `${categoryLabel(details.before, details.beforeName)} → ${categoryLabel(details.after, details.afterName)}`;
  }
  const financeSummary = financeActivitySummary(event);
  if (financeSummary !== undefined) return financeSummary;
  const rootSummary = rootSummaries[event.root.type];
  if (rootSummary) return rootSummary(event);
  if (event.action === "audit.answer_changed") {
    return `${textValue(details.prompt)} · ${answerLabel(details.before, details.responseType)} → ${answerLabel(details.after, details.responseType)}`;
  }
  if (event.action.startsWith("audit.template_")) {
    return `Version ${textValue(details.version)}`;
  }
  return textValue(details.title) || textValue(details.filename) || "Details";
}

function ActivityRow({
  event,
  onNavigate,
}: {
  event: ActivityEvent;
  onNavigate: ((pathname: string) => void) | undefined;
}) {
  const href = activityPath(event);
  return (
    <li className="row activityRow">
      <div className="rowMain activityMain">
        <p className="activityHeading">
          <strong title={actorDetail(event.actor)}>
            {actorName(event.actor)}
          </strong>
          <ApiKeyAttribution actor={event.actor} />{" "}
          {actionLabels[event.action] ?? event.action}
        </p>
        <p className="activityMeta">
          {actorDetail(event.actor)} ·{" "}
          <time dateTime={event.occurredAt}>
            {formatDateTime(event.occurredAt)}
          </time>
        </p>
        {onNavigate && <p className="activityRoot">{event.root.label}</p>}
        <ActivityDetails event={event} />
        {event.historical && (
          <span>
            <Badge>From existing records</Badge>
          </span>
        )}
      </div>
      {onNavigate && href && (
        <Button onClick={() => onNavigate(href)} size="sm">
          {activityLinkLabel(event)}
        </Button>
      )}
    </li>
  );
}

/** Details that are the root's one-line summary. */
const detailSummaries: Partial<
  Record<string, (event: ActivityEvent) => string>
> = {
  api_key: apiKeySummary,
  contract: contractActivitySummary,
  contract_template: contractActivitySummary,
  employee_requirement: requirementActivitySummary,
  organization: organizationActivitySummary,
  organization_group: groupActivitySummary,
  organization_invitation: organizationActivitySummary,
  project: projectActivitySummary,
  user: purgeSummary,
};

function ActivityDetails({ event }: { event: ActivityEvent }) {
  const details = event.details;
  // Links are recorded on equipment and transactions too.
  const summary = isLibraryActivity(event)
    ? libraryActivitySummary(event)
    : (financeActivitySummary(event) ??
      (membershipActions.has(event.action)
        ? membershipSummary(event)
        : detailSummaries[event.root.type]?.(event)));
  if (summary !== undefined)
    return <p className="activityDetails">{summary}</p>;
  if (event.root.type === "equipment") {
    return <EquipmentActivityDetails event={event} />;
  }
  if (
    event.action === "finance.transaction_annotated" ||
    event.action === "issue.updated"
  )
    return <RecordActivityDetails event={event} />;
  switch (event.action) {
    case "audit.offline_synced":
      return (
        <p className="activityDetails">
          Device-reported times: started {textValue(details.clientStartedAt)},
          completed {textValue(details.clientCompletedAt)}. Synced at{" "}
          {formatDateTime(event.occurredAt)}.
        </p>
      );
    case "organization.member_role_changed":
      return <MemberRoleDetails event={event} />;
    case "organization.member_two_factor_requirement_changed":
      return (
        <div className="activityDetails">
          <p>
            {memberLabel(event)} · {textValue(details.userEmail)}
          </p>
          <p>{twoFactorSummary(event)}</p>
        </div>
      );
    case "finance.transaction_categorized":
      return (
        <div className="activityDetails">
          <p className="activityChange">
            <span>{categoryLabel(details.before, details.beforeName)}</span>
            <span aria-hidden="true">→</span>
            <span className="srOnly">changed to</span>
            <span>{categoryLabel(details.after, details.afterName)}</span>
          </p>
        </div>
      );
    case "audit.answer_changed":
      return (
        <div className="activityDetails">
          <p>{textValue(details.prompt)}</p>
          <p className="activityChange">
            <span>{answerLabel(details.before, details.responseType)}</span>
            <span aria-hidden="true">→</span>
            <span className="srOnly">changed to</span>
            <span>{answerLabel(details.after, details.responseType)}</span>
          </p>
        </div>
      );
    case "issue.assigned":
    case "audit.issue_assigned":
      return (
        <div className="activityDetails">
          <p>{textValue(details.title)}</p>
          <p>
            {assigneeLabel(
              details.before,
              details.beforeName,
              details.beforeEmail,
            )}{" "}
            →{" "}
            {assigneeLabel(
              details.after,
              details.afterName,
              details.afterEmail,
            )}
          </p>
        </div>
      );
    case "issue.created":
    case "audit.issue_created":
      return (
        <div className="activityDetails">
          <p>{textValue(details.title)}</p>
          {details.description ? <p>{textValue(details.description)}</p> : null}
          <p>
            Priority: {textValue(details.priority)}
            {!event.historical && (
              <>
                {" "}
                · Assigned to:{" "}
                {assigneeLabel(
                  details.assignedTo,
                  details.assigneeName,
                  details.assigneeEmail,
                )}
              </>
            )}
          </p>
        </div>
      );
    case "audit.image_uploaded":
    case "audit.image_removed":
      return (
        <p className="activityDetails">
          {textValue(details.filename)} · {textValue(details.title)}
        </p>
      );
    case "audit.template_created":
    case "audit.template_discarded":
    case "audit.template_published":
    case "audit.template_restored":
    case "audit.template_unpublished":
    case "audit.template_version_saved":
      return <TemplateDetails details={details} />;
    default:
      return details.title ? (
        <p className="activityDetails">{textValue(details.title)}</p>
      ) : null;
  }
}

/** A form version, and the published global version a copy started from. */
function TemplateDetails({ details }: { details: ActivityEvent["details"] }) {
  const source = details.copiedFrom;
  const copiedVersion =
    typeof source === "object" && source !== null
      ? textValue(Reflect.get(source, "version"))
      : "";
  const copied =
    typeof source === "object" && source !== null
      ? ` · Copied from ${textValue(Reflect.get(source, "name")) || "a global form"}${copiedVersion && `, version ${copiedVersion}`}`
      : null;
  return (
    <p className="activityDetails">
      Version {textValue(details.version)}
      {copied}
    </p>
  );
}

function MemberRoleDetails({ event }: { event: ActivityEvent }) {
  return (
    <div className="activityDetails">
      <p>
        {memberLabel(event)} · {textValue(event.details.userEmail)}
      </p>
      <p>
        {formatRoles(textValue(event.details.before))} →{" "}
        {formatRoles(textValue(event.details.after))}
      </p>
    </div>
  );
}

function twoFactorSummary({ details }: ActivityEvent) {
  const label = (required: unknown) => (required ? "Required" : "Not required");
  return `Two-factor: ${label(details.before)} → ${label(details.after)}`;
}

function answerLabel(value: unknown, responseType: unknown) {
  if (value == null || value === "") return "Unanswered";
  if (responseType === "check") {
    if (value === "na") return "N/A";
    if (value === "pass") return "Pass";
    if (value === "fail") return "Fail";
  }
  return textValue(value);
}

/** Names the category as it was when the event was recorded. */
function categoryLabel(id: unknown, name: unknown) {
  if (id == null) return "Uncategorized";
  return textValue(name) || "Deleted category";
}

function activityPath(event: ActivityEvent) {
  if (event.subject.type === "issue" || event.subject.type === "audit_issue")
    return issuePath(event.subject.id);
  if (event.root.type.startsWith("finance_")) return financeActivityPath(event);
  // Deleted equipment has no page to open.
  if (event.root.type === "equipment") {
    return event.action === "equipment.deleted"
      ? undefined
      : equipmentPath(event.root.id);
  }
  if (event.root.type.startsWith("organization_"))
    return organizationActivityPath(event);
  // A deleted project has no page to open.
  if (event.root.type === "project")
    return event.action === "project.deleted"
      ? undefined
      : projectPath(event.root.id);
  if (event.root.type === "audit_run") return auditRunPath(event.root.id);
  return contractActivityPath(event);
}

/** Pages of contracts, templates, and requests, which go once deleted. */
const contractRecordPaths: Partial<Record<string, (id: string) => string>> = {
  contract: contractPath,
  contract_template: contractTemplatePath,
  employee_requirement: organizationRequirementPath,
};

/** Forms; contracts, templates, and requests until deleted; then library. */
function contractActivityPath(event: ActivityEvent) {
  if (event.root.type === "audit_template")
    return auditTemplatePath(event.root.id);
  const recordPath = contractRecordPaths[event.root.type];
  if (recordPath)
    return event.action.endsWith(".deleted")
      ? undefined
      : recordPath(event.root.id);
  return libraryActivityPath(event);
}

/**
 * Deleted folders and businesses, and files, have no page. An email's events
 * do not link either: an event cannot tell which folder the email is in now.
 */
function libraryActivityPath({ action, root }: ActivityEvent) {
  switch (root.type) {
    case "library_folder":
      return action === "library.folder_deleted"
        ? undefined
        : libraryPath(root.id);
    case "business":
      return action === "business.deleted" ? undefined : businessPath(root.id);
    default:
      return undefined;
  }
}

function financeActivityPath(event: ActivityEvent) {
  // Deleting a connection's data also deletes its page.
  if (event.root.type === "finance_connection")
    return event.action === "finance.connection_data_deleted"
      ? undefined
      : financeConnectionPath(event.root.id);
  if (event.root.type === "finance_category") return financeCategoriesPath;
  if (event.root.type === "finance_transaction")
    return financeTransactionPath(event.root.id);
  return undefined;
}

function organizationActivityPath(event: ActivityEvent) {
  // People who left or were removed have no member page.
  if (event.root.type === "organization_member")
    return event.action === "organization.member_left" ||
      event.action === "organization.member_removed"
      ? undefined
      : organizationPeoplePath(event.root.id);
  if (event.root.type === "organization_billing") return billingPath;
  // Groups have no page of their own; deleted ones have nowhere to go.
  if (event.root.type === "organization_group")
    return event.action === "organization.group_deleted"
      ? undefined
      : organizationAccessPath;
  return undefined;
}

/** The button that opens an event's record, by root type. */
const linkLabels: Partial<Record<string, string>> = {
  audit_run: "Open audit",
  business: "Open business",
  contract: "Open contract",
  contract_template: "Open template",
  employee_requirement: "Open request",
  equipment: "Open equipment",
  finance_category: "Open categories",
  finance_connection: "Open connection",
  finance_transaction: "Open transaction",
  library_folder: "Open folder",
  organization_billing: "Open billing",
  organization_group: "Open groups",
  organization_member: "Open member",
  project: "Open project",
};

function activityLinkLabel(event: ActivityEvent) {
  if (event.subject.type === "issue" || event.subject.type === "audit_issue")
    return "Open issue";
  return linkLabels[event.root.type] ?? "Open form";
}

function apiKeySummary({ details }: ActivityEvent) {
  const access = details.access === "write" ? "Read and write" : "Read only";
  return `${access} · ${textValue(details.prefix)}…`;
}

function memberLabel(event: ActivityEvent) {
  return (
    textValue(event.details.userName) ||
    textValue(event.details.userEmail) ||
    event.root.label
  );
}

const channelLabels = { mcp: "MCP", rest: "API" } as const;

/** Names the API key, if any, that the actor made a change through. */
export function ApiKeyAttribution({ actor }: { actor: ActivityActor }) {
  if (!actor.apiKey) return null;
  const { channel, name } = actor.apiKey;
  return (
    <span
      className="activityApiKey"
      title={`API key, called through ${channel === "mcp" ? "MCP" : "the REST API"}`}
    >
      {` via ${name} (${channelLabels[channel]})`}
    </span>
  );
}
