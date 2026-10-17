import {
  activityCursor,
  id,
  integer,
  type McpTool,
  nullable,
  object,
  oneOf,
  text,
} from "./mcpToolSchema";

const fields = {
  title: text("Short issue title.", { minLength: 1, maxLength: 300 }),
  description: text("Issue details.", { maxLength: 2000 }),
  priority: oneOf("Priority; defaults to medium.", [
    "low",
    "medium",
    "high",
    "critical",
  ]),
  assignedTo: nullable(
    id(
      "Organization member user id, or null to unassign. Use list_issue_members.",
    ),
  ),
};
export const issueTools: McpTool[] = [
  {
    name: "list_issues",
    title: "List issues",
    method: "GET",
    path: "/api/issues",
    description:
      "Lists workspace, audit, and transaction issues, newest first, 50 per page. Defaults to open. Finance issues require Finance access.",
    query: {
      status: oneOf("Status filter.", ["open", "resolved", "all"]),
      type: oneOf("Source type.", [
        "all",
        "workspace",
        "audit_run",
        "finance_transaction",
      ]),
      targetId: id("Optional source record id."),
      q: text("Search title.", { maxLength: 200 }),
      cursor: text("The nextCursor from the previous page."),
    },
  },
  {
    name: "get_issue",
    title: "Get issue",
    method: "GET",
    path: "/api/issues/{id}",
    params: { id: id("Issue id.") },
    description:
      "Gets an issue, its source, assignee, status, and revision for updates.",
  },
  {
    name: "list_issue_members",
    title: "List issue assignees",
    method: "GET",
    path: "/api/issues/members",
    description:
      "Lists organization member user ids that can be assigned issues.",
  },
  {
    name: "list_issue_activity",
    title: "List issue activity",
    method: "GET",
    path: "/api/issues/{id}/activity",
    params: { id: id("Issue id.") },
    query: { cursor: activityCursor },
    description:
      "Lists the issue's history, including legacy audit issue events.",
  },
  {
    name: "create_issue",
    title: "Raise issue",
    method: "POST",
    path: "/api/issues",
    description:
      "Raises an issue for a transaction or audit item. Omit target for a workspace issue. Finance sources require Finance access.",
    body: {
      properties: {
        ...fields,
        target: object(
          "Source record; omit for workspace.",
          {
            type: oneOf("Source type.", ["finance_transaction", "audit_run"]),
            id: id("Source record id."),
            itemId: id(
              "Required only for audit_run: item id from the audit definition.",
            ),
          },
          ["type", "id"],
        ),
      },
      required: ["title"],
    },
  },
  {
    name: "update_issue",
    title: "Update issue",
    method: "PATCH",
    path: "/api/issues/{id}",
    params: { id: id("Issue id.") },
    description:
      "Edits, assigns, resolves, or reopens an issue. Send its current revision; stale writes are rejected. Sources that are unavailable are read only.",
    body: {
      properties: {
        ...fields,
        expectedRevision: integer("Revision from get_issue.", { minimum: 0 }),
        status: oneOf("New status.", ["open", "resolved"]),
      },
      required: ["expectedRevision"],
    },
  },
  {
    name: "get_transaction",
    title: "Get transaction",
    method: "GET",
    path: "/api/finance/transactions/{id}",
    params: { id: id("Transaction id.") },
    description:
      "Gets one active transaction, its annotations and linked emails, plus expense categories. Requires Finance access.",
  },
  {
    name: "list_transaction_activity",
    title: "List transaction activity",
    method: "GET",
    path: "/api/finance/transactions/{id}/activity",
    params: { id: id("Transaction id.") },
    query: { cursor: activityCursor },
    description:
      "Lists transaction annotation changes and issue activity. Requires Finance access.",
  },
];
