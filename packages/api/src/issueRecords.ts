import type { Issue, IssueTargetType } from "@balebase/validators/issues";
import type { Context } from "hono";
import { storedDefinition } from "./auditTemplates";
import type { ApiEnv } from "./authMiddleware";
import { userHasCapability } from "./organizationGroups";

export type IssueContext = Context<ApiEnv>;
export interface IssueTarget {
  type: IssueTargetType;
  id: string | null;
  itemId: string | null;
}
export interface IssueRow {
  id: string;
  organization_id: string;
  target_type: IssueTargetType;
  target_id: string | null;
  item_id: string | null;
  title: string;
  description: string;
  priority: Issue["priority"];
  status: Issue["status"];
  assigned_to: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  created_by: string;
  creator_name: string;
  creator_email: string;
  created_at: string;
  updated_at: string;
  revision: number;
  target_label: string;
  target_available: number;
}

export const issueSelect = `SELECT issue.*, creator.name AS creator_name, creator.email AS creator_email,
  assignee.name AS assignee_name, assignee.email AS assignee_email,
  COALESCE(audit.template_name, txn.merchant_name, txn.name, 'Workspace') AS target_label,
  CASE WHEN issue.target_type = 'workspace' THEN 1
       WHEN issue.target_type = 'audit_run' THEN audit.id IS NOT NULL AND audit.deleted_at IS NULL
       ELSE txn.id IS NOT NULL AND txn.source_status = 'active' END AS target_available
  FROM issues AS issue
  JOIN user AS creator ON creator.id = issue.created_by
  LEFT JOIN user AS assignee ON assignee.id = issue.assigned_to
  LEFT JOIN audits AS audit ON issue.target_type = 'audit_run' AND audit.id = issue.target_id
  LEFT JOIN plaid_transactions AS txn ON issue.target_type = 'finance_transaction' AND txn.id = issue.target_id`;

export function canSeeFinanceIssues(context: IssueContext) {
  return userHasCapability(
    context.env.DB,
    context.get("organizationId"),
    context.get("authSession").user.id,
    "finance",
  );
}

export async function findIssue(context: IssueContext, id: string) {
  return context.env.DB.prepare(`${issueSelect}
    WHERE issue.organization_id = ? AND issue.id = ?
      AND (? = 1 OR issue.target_type <> 'finance_transaction')`)
    .bind(
      context.get("organizationId"),
      id,
      (await canSeeFinanceIssues(context)) ? 1 : 0,
    )
    .first<IssueRow>();
}

export function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    target: {
      type: row.target_type,
      id: row.target_id,
      itemId: row.item_id,
      label: row.target_label,
      available: Boolean(row.target_available),
    },
    assignedTo: row.assigned_to
      ? {
          id: row.assigned_to,
          name: row.assignee_name ?? "",
          email: row.assignee_email ?? "",
        }
      : null,
    createdBy: {
      id: row.created_by,
      name: row.creator_name,
      email: row.creator_email,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export async function issueTargetAvailable(
  context: IssueContext,
  target: IssueTarget,
) {
  if (target.type === "workspace") return true;
  if (target.type === "finance_transaction") {
    if (!(await canSeeFinanceIssues(context))) return false;
    return Boolean(
      await context.env.DB.prepare(`SELECT id FROM plaid_transactions
      WHERE id = ? AND organization_id = ? AND source_status = 'active'`)
        .bind(target.id, context.get("organizationId"))
        .first(),
    );
  }
  const audit = await context.env.DB.prepare(`SELECT definition FROM audits
    WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
    .bind(target.id, context.get("organizationId"))
    .first<{ definition: string }>();
  return Boolean(
    audit &&
      storedDefinition(audit.definition).sections.some((section) =>
        section.items.some((item) => item.id === target.itemId),
      ),
  );
}

/** Recheck the target within the mutation's transaction, after its initial read. */
export const issueTargetWritable = `(target_type = 'workspace'
  OR (target_type = 'audit_run' AND EXISTS (SELECT 1 FROM audits
    WHERE audits.id = issues.target_id AND audits.organization_id = issues.organization_id AND deleted_at IS NULL))
  OR (target_type = 'finance_transaction' AND EXISTS (SELECT 1 FROM plaid_transactions
    WHERE plaid_transactions.id = issues.target_id AND plaid_transactions.organization_id = issues.organization_id AND source_status = 'active')))`;

// Checked in the write itself, so a member removed meanwhile cannot be
// assigned.
const isMember =
  "EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)";

/** A new issue, with its fields as the contract parsed them. */
export interface NewIssue {
  assignedTo?: string | null | undefined;
  description: string;
  id: string;
  priority: Issue["priority"];
  target: IssueTarget;
  title: string;
}

/**
 * Inserts an open issue. It inserts nothing if the assignee is not a member,
 * and fails if the target is unavailable.
 */
export function issueInsert(context: IssueContext, issue: NewIssue) {
  const organizationId = context.get("organizationId");
  const assignedTo = issue.assignedTo ?? null;
  const now = new Date().toISOString();
  return context.env.DB.prepare(`INSERT INTO issues
    (id, organization_id, target_type, target_id, item_id, title, description, priority, status, assigned_to, created_by, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?
    WHERE ? IS NULL OR ${isMember}`).bind(
    issue.id,
    organizationId,
    issue.target.type,
    issue.target.id,
    issue.target.itemId,
    issue.title,
    issue.description,
    issue.priority,
    assignedTo,
    context.get("authSession").user.id,
    now,
    now,
    assignedTo,
    organizationId,
    assignedTo,
  );
}

export interface IssueChanges {
  assignedTo?: string | null | undefined;
  description?: string | undefined;
  priority?: Issue["priority"] | undefined;
  status?: Issue["status"] | undefined;
  title?: string | undefined;
}

const changeColumns = {
  assignedTo: "assigned_to",
  description: "description",
  priority: "priority",
  status: "status",
  title: "title",
} as const;

/**
 * Updates the fields given, and the revision, where `guard` holds. It
 * changes nothing if a new assignee is not a member; an unchanged assignee
 * may stay after leaving.
 */
export function issueUpdate(
  context: IssueContext,
  id: string,
  changes: IssueChanges & { updatedAt: string },
  guard: { bindings: (number | string)[]; sql: string },
) {
  const organizationId = context.get("organizationId");
  const assignedTo = changes.assignedTo ?? null;
  const set = Object.entries(changeColumns).flatMap(([field, column]) => {
    const value = changes[field as keyof IssueChanges];
    return value === undefined ? [] : [{ column, value }];
  });
  return context.env.DB.prepare(`UPDATE issues
    SET ${set.map(({ column }) => `${column} = ?, `).join("")}updated_at = ?,
      activity_actor_id = ?, revision = revision + 1
    WHERE id = ? AND organization_id = ? AND ${guard.sql}
      AND (? IS NULL OR ? IS assigned_to OR ${isMember})`).bind(
    ...set.map(({ value }) => value),
    changes.updatedAt,
    context.get("authSession").user.id,
    id,
    organizationId,
    ...guard.bindings,
    assignedTo,
    assignedTo,
    organizationId,
    assignedTo,
  );
}
