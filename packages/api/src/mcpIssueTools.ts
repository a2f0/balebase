import { financeRoutes } from "@balebase/validators/finance";
import { issuesRoutes } from "@balebase/validators/issues";
import { activityCursor, type McpTool } from "./mcpToolSchema";

const issueId = { id: "Issue id." };

const fields = {
  assignedTo:
    "Organization member user id, or null to unassign. Use list_issue_members.",
  description: "Issue details.",
  priority: "Priority; defaults to medium.",
  title: "Short issue title.",
};

export const issueTools: McpTool[] = [
  {
    name: "list_issues",
    title: "List issues",
    route: issuesRoutes.list,
    description:
      "Lists workspace, audit, and transaction issues, newest first, 50 per page. Defaults to open. Finance issues require Finance access.",
    descriptions: {
      cursor: "The nextCursor from the previous page.",
      q: "Search title.",
      status: "Status filter.",
      targetId: "Optional source record id.",
      type: "Source type.",
    },
  },
  {
    name: "get_issue",
    title: "Get issue",
    route: issuesRoutes.get,
    descriptions: issueId,
    description:
      "Gets an issue, its source, assignee, status, and revision for updates.",
  },
  {
    name: "list_issue_members",
    title: "List issue assignees",
    route: issuesRoutes.members,
    description:
      "Lists organization member user ids that can be assigned issues.",
  },
  {
    name: "list_issue_activity",
    title: "List issue activity",
    route: issuesRoutes.activity,
    descriptions: { ...issueId, ...activityCursor },
    description:
      "Lists the issue's history, including legacy audit issue events.",
  },
  {
    name: "create_issue",
    title: "Raise issue",
    route: issuesRoutes.create,
    description:
      "Raises an issue for a transaction or audit item. Omit target for a workspace issue. Finance sources require Finance access.",
    descriptions: {
      ...fields,
      target: "Source record; omit for workspace.",
      "target.id": "Source record id.",
      "target.itemId":
        "Required only for audit_run: item id from the audit definition.",
      "target.type": "Source type.",
    },
    // New issues are always open.
    omit: ["status"],
  },
  {
    name: "update_issue",
    title: "Update issue",
    route: issuesRoutes.update,
    description:
      "Edits, assigns, resolves, or reopens an issue. Send its current revision; stale writes are rejected. Sources that are unavailable are read only.",
    descriptions: {
      ...issueId,
      ...fields,
      expectedRevision: "Revision from get_issue.",
      status: "New status.",
    },
  },
  {
    name: "get_transaction",
    title: "Get transaction",
    route: financeRoutes.transaction,
    descriptions: { id: "Transaction id." },
    description:
      "Gets one active transaction, its annotations and linked emails, plus expense categories. Requires Finance access.",
  },
  {
    name: "list_transaction_activity",
    title: "List transaction activity",
    route: financeRoutes.transactionActivity,
    descriptions: { id: "Transaction id.", ...activityCursor },
    description:
      "Lists transaction annotation changes and issue activity. Requires Finance access.",
  },
];
