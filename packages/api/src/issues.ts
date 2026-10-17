import { Hono } from "hono";
import { activityBatch, findActivity } from "./activity";
import { isRecord } from "./auditDefinition";
import {
  canSeeFinanceIssues,
  findIssue,
  type IssueContext,
  type IssueEnv,
  type IssueRow,
  issueSelect,
  issueTargetAvailable,
  issueTargetWritable,
  parseIssueInput,
  parseIssueTarget,
  toIssue,
} from "./issueRecords";
import { listMemberDirectory } from "./organizationMembers";

export const issues = new Hono<IssueEnv>();
issues.get("/", listIssues);
issues.get("/members", async (context) =>
  context.json({
    members: await listMemberDirectory(
      context.env.DB,
      context.get("organizationId"),
    ),
  }),
);
issues.get("/:id", async (context) => {
  const issue = await findIssue(context, context.req.param("id"));
  return issue
    ? context.json({ issue: toIssue(issue) })
    : context.json({ error: "Issue not found." }, 404);
});
issues.get("/:id/activity", async (context) => {
  const issue = await findIssue(context, context.req.param("id"));
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    context.get("organizationId"),
    context.req.query("cursor"),
    { id: issue.id, type: "issue", issueOnly: true },
    issue.target_type === "finance_transaction",
  );
  return page
    ? context.json(page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});
issues.post("/", createIssue);
issues.patch("/:id", updateIssue);

async function listIssues(context: IssueContext) {
  const filter = issueFilters(context);
  if (!filter) return context.json({ error: "Invalid issue filters." }, 400);
  const finance = await canSeeFinanceIssues(context);
  const rows = await context.env.DB.prepare(`${issueSelect}
    WHERE issue.organization_id = ? AND (? = 1 OR issue.target_type <> 'finance_transaction')
      AND target_available = 1 ${filter.sql}
    ORDER BY issue.created_at DESC, issue.id DESC LIMIT 51`)
    .bind(context.get("organizationId"), finance ? 1 : 0, ...filter.bindings)
    .all<IssueRow>();
  const page = rows.results.slice(0, 50);
  const last = page.at(-1);
  return context.json({
    issues: page.map(toIssue),
    nextCursor:
      rows.results.length > 50 && last
        ? JSON.stringify({ createdAt: last.created_at, id: last.id })
        : null,
  });
}

function issueFilters(context: IssueContext) {
  const status = context.req.query("status") ?? "open";
  const type = context.req.query("type") ?? "all";
  const targetId = context.req.query("targetId");
  const query = context.req.query("q")?.trim() ?? "";
  if (
    !["open", "resolved", "all"].includes(status) ||
    !["all", "audit_run", "finance_transaction", "workspace"].includes(type) ||
    query.length > 200 ||
    (targetId !== undefined && (!targetId || targetId.length > 200))
  )
    return null;
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (status !== "all") {
    conditions.push("issue.status = ?");
    bindings.push(status);
  }
  if (type !== "all") {
    conditions.push("issue.target_type = ?");
    bindings.push(type);
  }
  if (targetId) {
    conditions.push("issue.target_id = ?");
    bindings.push(targetId);
  }
  if (query) {
    conditions.push("issue.title LIKE ? ESCAPE '\\'");
    bindings.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
  }
  const value = context.req.query("cursor");
  if (value !== undefined) {
    const cursor = parseCursor(value);
    if (!cursor) return null;
    conditions.push("(issue.created_at, issue.id) < (?, ?)");
    bindings.push(cursor.createdAt, cursor.id);
  }
  return {
    sql: conditions.length ? `AND ${conditions.join(" AND ")}` : "",
    bindings,
  };
}

function parseCursor(value: string) {
  if (value.length > 500) return null;
  try {
    const cursor: unknown = JSON.parse(value);
    if (!isRecord(cursor)) return null;
    const { createdAt } = cursor;
    if (
      typeof createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      !cursor.id
    )
      return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt))
      return null;
    return { createdAt, id: cursor.id };
  } catch {
    return null;
  }
}

async function createIssue(context: IssueContext) {
  const body: unknown = await context.req.json().catch(() => null);
  if (!isRecord(body))
    return context.json({ error: "Invalid issue details." }, 400);
  const input = parseIssueInput({
    status: "open",
    description: "",
    priority: "medium",
    assignedTo: null,
    ...body,
  });
  const { target: rawTarget } = body;
  const target = parseIssueTarget(rawTarget);
  if (!input || !target || input.status !== "open")
    return context.json({ error: "Invalid issue details." }, 400);
  if (!(await issueTargetAvailable(context, target)))
    return context.json({ error: "Issue target not found." }, 404);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const organizationId = context.get("organizationId");
  const insert = context.env.DB.prepare(`INSERT INTO issues
    (id, organization_id, target_type, target_id, item_id, title, description, priority, status, assigned_to, created_by, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?
    WHERE ? IS NULL OR EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`).bind(
    id,
    organizationId,
    target.type,
    target.id,
    target.itemId,
    input.title,
    input.description,
    input.priority,
    input.assignedTo,
    context.get("authSession").user.id,
    now,
    now,
    input.assignedTo,
    organizationId,
    input.assignedTo,
  );
  try {
    const [result] = await activityBatch(
      context.env.DB,
      context.get("apiKey"),
      [insert],
    );
    if (!Number(result?.meta.changes))
      return context.json({ error: "Issue assignee is not a member." }, 400);
  } catch (cause) {
    if (!(await issueTargetAvailable(context, target)))
      return context.json(
        { error: "Issue target is no longer available." },
        409,
      );
    throw cause;
  }
  return context.json({ issueId: id }, 201);
}

async function updateIssue(context: IssueContext) {
  const issue = await findIssue(context, context.req.param("id") ?? "");
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  const body: unknown = await context.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    return context.json({ error: "A valid issue revision is required." }, 400);
  const input = parseIssueInput({
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    status: issue.status,
    assignedTo: issue.assigned_to,
    ...body,
  });
  if (!input) return context.json({ error: "Invalid issue details." }, 400);
  const organizationId = context.get("organizationId");
  const update =
    context.env.DB.prepare(`UPDATE issues SET title = ?, description = ?, priority = ?, status = ?, assigned_to = ?,
      updated_at = ?, activity_actor_id = ?, revision = revision + 1
    WHERE id = ? AND organization_id = ? AND revision = ? AND ${issueTargetWritable}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?))`).bind(
      input.title,
      input.description,
      input.priority,
      input.status,
      input.assignedTo,
      new Date().toISOString(),
      context.get("authSession").user.id,
      issue.id,
      organizationId,
      body.expectedRevision,
      input.assignedTo,
      organizationId,
      input.assignedTo,
    );
  const [result] = await activityBatch(context.env.DB, context.get("apiKey"), [
    update,
  ]);
  if (!Number(result?.meta.changes))
    return context.json(
      {
        error:
          "This issue changed, its source is unavailable, or the assignee is no longer a member. Reload before saving.",
      },
      409,
    );
  const updated = await findIssue(context, issue.id);
  return updated
    ? context.json({ issue: toIssue(updated) })
    : context.json({ error: "Issue not found." }, 404);
}
