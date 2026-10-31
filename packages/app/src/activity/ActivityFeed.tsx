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
  businessPath,
  equipmentPath,
  financeConnectionPath,
  financeTransactionPath,
  issuePath,
  libraryPath,
  organizationAccessPath,
  organizationPeoplePath,
  projectPath,
} from "../workspace/workspacePaths";
import { assigneeLabel, textValue } from "./activityLabels";
import { type ActivitySource, listActivity } from "./activitySource";
import {
  EquipmentActivityDetails,
  equipmentActivitySummary,
} from "./EquipmentActivity";
import { groupActivitySummary } from "./groupActivity";
import { isLibraryActivity, libraryActivitySummary } from "./libraryActivity";
import { projectActivitySummary } from "./projectActivity";
import { RecordActivityDetails } from "./RecordActivity";

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
  "audit.template_restored": "restored the form",
  "audit.template_version_saved": "saved a form version",
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
};

export function ActivityFeed({
  compact = false,
  onNavigate,
  refreshKey,
  resourceType,
  source,
}: {
  compact?: boolean;
  onNavigate?: (pathname: string) => void;
  refreshKey?: unknown;
  resourceType?: ActivityResourceType | undefined;
  source?: ActivitySource;
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
      title={compact ? "Recent activity" : "Activity"}
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
          <strong title={event.actor.email}>
            {event.actor.name || event.actor.email}
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
          <p className="activityMeta">{event.actor.email}</p>
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
    equipment: equipmentActivitySummary,
    organization_group: groupActivitySummary,
    organization_member: memberSummary,
    project: projectActivitySummary,
  };

function memberSummary(event: ActivityEvent) {
  const change =
    event.action === "organization.member_two_factor_requirement_changed"
      ? twoFactorSummary(event)
      : `${formatRoles(textValue(event.details.before))} → ${formatRoles(textValue(event.details.after))}`;
  return `${memberLabel(event)} · ${change}`;
}

function activitySummary(event: ActivityEvent) {
  const { details } = event;
  // Links are recorded on equipment and transactions too.
  if (isLibraryActivity(event)) return libraryActivitySummary(event);
  if (event.action === "finance.daily_sync_changed")
    return `Daily sync ${details.before ? "on" : "off"} → ${details.after ? "on" : "off"}`;
  if (event.action === "finance.transaction_annotated")
    return "Annotation changes";
  if (event.action === "finance.transaction_categorized") {
    return `${categoryLabel(details.before, details.beforeName)} → ${categoryLabel(details.after, details.afterName)}`;
  }
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
          <strong title={event.actor.email}>
            {event.actor.name || event.actor.email}
          </strong>
          <ApiKeyAttribution actor={event.actor} />{" "}
          {actionLabels[event.action] ?? event.action}
        </p>
        <p className="activityMeta">
          {event.actor.email} ·{" "}
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

function ActivityDetails({ event }: { event: ActivityEvent }) {
  const details = event.details;
  if (event.action === "finance.daily_sync_changed")
    return <p>{activitySummary(event)}</p>;
  const rooted = rootDetails(event);
  if (rooted) return rooted;
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
    case "audit.template_restored":
    case "audit.template_version_saved":
      return (
        <p className="activityDetails">Version {textValue(details.version)}</p>
      );
    default:
      return details.title ? (
        <p className="activityDetails">{textValue(details.title)}</p>
      ) : null;
  }
}

/** Details shared by every event on some roots, and library links anywhere. */
function rootDetails(event: ActivityEvent) {
  // Links are recorded on equipment and transactions too.
  if (isLibraryActivity(event)) {
    return <p className="activityDetails">{libraryActivitySummary(event)}</p>;
  }
  if (event.root.type === "equipment") {
    return <EquipmentActivityDetails event={event} />;
  }
  if (event.root.type === "api_key") {
    return <p className="activityDetails">{apiKeySummary(event)}</p>;
  }
  if (event.root.type === "project") {
    return <p className="activityDetails">{projectActivitySummary(event)}</p>;
  }
  if (event.root.type === "organization_group") {
    return <p className="activityDetails">{groupActivitySummary(event)}</p>;
  }
  return undefined;
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
  if (event.root.type === "finance_connection")
    return financeConnectionPath(event.root.id);
  if (event.root.type === "finance_transaction")
    return financeTransactionPath(event.root.id);
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
  if (event.root.type === "audit_template")
    return auditTemplatePath(event.root.id);
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

function organizationActivityPath(event: ActivityEvent) {
  if (event.root.type === "organization_member")
    return organizationPeoplePath(event.root.id);
  // Groups have no page of their own; deleted ones have nowhere to go.
  if (event.root.type === "organization_group")
    return event.action === "organization.group_deleted"
      ? undefined
      : organizationAccessPath;
  return undefined;
}

function activityLinkLabel(event: ActivityEvent) {
  if (event.subject.type === "issue" || event.subject.type === "audit_issue")
    return "Open issue";
  if (event.root.type === "finance_connection") return "Open connection";
  if (event.root.type === "finance_transaction") return "Open transaction";
  if (event.root.type === "equipment") return "Open equipment";
  if (event.root.type === "organization_member") return "Open member";
  if (event.root.type === "organization_group") return "Open groups";
  if (event.root.type === "project") return "Open project";
  if (event.root.type === "library_folder") return "Open folder";
  if (event.root.type === "business") return "Open business";
  return event.root.type === "audit_run" ? "Open audit" : "Open form";
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
