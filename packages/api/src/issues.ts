import { issuesRoutes } from "@balebase/validators/issues";
import { Hono } from "hono";
import { activityBatch, findActivity } from "./activity";
import type { ApiEnv } from "./authMiddleware";
import { cursorPage, decodeCursor, encodeCursor } from "./cursorPagination";
import {
  canSeeFinanceIssues,
  findIssue,
  type IssueContext,
  type IssueRow,
  issueInsert,
  issueSelect,
  issueTargetAvailable,
  issueTargetWritable,
  issueUpdate,
  toIssue,
} from "./issueRecords";
import { listMemberDirectory } from "./organizationMembers";
import { readBody, respond } from "./respond";

export const issues = new Hono<ApiEnv>();
const issuePageSize = 50;
issues.get("/", listIssues);
issues.get("/members", async (context) =>
  respond(context, issuesRoutes.members, {
    members: await listMemberDirectory(
      context.env.DB,
      context.get("organizationId"),
    ),
  }),
);
issues.get("/:id", async (context) => {
  const issue = await findIssue(context, context.req.param("id"));
  return issue
    ? respond(context, issuesRoutes.get, { issue: toIssue(issue) })
    : context.json({ error: "Issue not found." }, 404);
});
issues.get("/:id/activity", async (context) => {
  const issue = await findIssue(context, context.req.param("id"));
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    context.get("organizationId"),
    context.req.query("cursor"),
    {
      id: issue.target_id ?? issue.id,
      type: issue.target_type === "workspace" ? "issue" : issue.target_type,
      issueId: issue.id,
    },
    issue.target_type === "finance_transaction",
  );
  return page
    ? respond(context, issuesRoutes.activity, page)
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
    ORDER BY issue.created_at DESC, issue.id DESC LIMIT ?`)
    .bind(
      context.get("organizationId"),
      finance ? 1 : 0,
      ...filter.bindings,
      issuePageSize + 1,
    )
    .all<IssueRow>();
  const page = cursorPage(rows.results, issuePageSize, (row) =>
    encodeCursor(row.created_at, row.id),
  );
  return respond(context, issuesRoutes.list, {
    issues: page.items.map(toIssue),
    nextCursor: page.nextCursor,
  });
}

function issueFilters(context: IssueContext) {
  const query = issuesRoutes.list.query.safeParse(context.req.query());
  if (!query.success) return null;
  const { cursor: value, q, status, targetId, type } = query.data;
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
  if (q) {
    conditions.push("issue.title LIKE ? ESCAPE '\\'");
    bindings.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (value !== undefined) {
    const cursor = parseCursor(value);
    if (!cursor) return null;
    conditions.push("(issue.created_at, issue.id) < (?, ?)");
    bindings.push(...cursor);
  }
  return {
    sql: conditions.length ? `AND ${conditions.join(" AND ")}` : "",
    bindings,
  };
}

function parseCursor(value: string) {
  const cursor = decodeCursor(value, "createdAt", 500);
  return cursor &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor[0])
    ? cursor
    : null;
}

async function createIssue(context: IssueContext) {
  const input = await readBody(
    context,
    issuesRoutes.create,
    "Invalid issue details.",
  );
  if (input instanceof Response) return input;
  const target = {
    type: input.target?.type ?? "workspace",
    id: input.target?.id ?? null,
    itemId: input.target?.itemId ?? null,
  };
  if (!(await issueTargetAvailable(context, target)))
    return context.json({ error: "Issue target not found." }, 404);
  const id = crypto.randomUUID();
  try {
    const [result] = await activityBatch(
      context.env.DB,
      context.get("apiKey"),
      [issueInsert(context, { ...input, id, target })],
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
  return respond(context, issuesRoutes.create, { issueId: id }, 201);
}

async function updateIssue(context: IssueContext) {
  const issue = await findIssue(context, context.req.param("id") ?? "");
  if (!issue) return context.json({ error: "Issue not found." }, 404);
  const input = await readBody(
    context,
    issuesRoutes.update,
    "Invalid issue details.",
  );
  if (input instanceof Response) return input;
  const { expectedRevision, ...changes } = input;
  const [result] = await activityBatch(context.env.DB, context.get("apiKey"), [
    issueUpdate(
      context,
      issue.id,
      { ...changes, updatedAt: new Date().toISOString() },
      {
        bindings: [expectedRevision],
        sql: `revision = ? AND ${issueTargetWritable}`,
      },
    ),
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
    ? respond(context, issuesRoutes.update, { issue: toIssue(updated) })
    : context.json({ error: "Issue not found." }, 404);
}
