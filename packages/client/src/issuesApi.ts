import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export type IssueTargetType = "audit_run" | "finance_transaction" | "workspace";
export interface IssueMember {
  id: string;
  name: string;
  email: string;
}
export interface Issue {
  id: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  status: "open" | "resolved";
  target: {
    type: IssueTargetType;
    id: string | null;
    itemId: string | null;
    label: string;
    available: boolean;
  };
  assignedTo: IssueMember | null;
  createdBy: IssueMember;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface IssueInput {
  title: string;
  description: string;
  priority: Issue["priority"];
  assignedTo: string | null;
}
export interface IssueFilters {
  status: "all" | Issue["status"];
  type: "all" | IssueTargetType;
  q: string;
  targetId?: string;
}
export interface IssuePage {
  issues: Issue[];
  nextCursor: string | null;
}
export function listIssues(filters: IssueFilters, cursor?: string) {
  const query = new URLSearchParams({
    status: filters.status,
    type: filters.type,
    q: filters.q,
  });
  if (filters.targetId) query.set("targetId", filters.targetId);
  if (cursor) query.set("cursor", cursor);
  return request<IssuePage>(`?${query}`);
}
export function getIssue(id: string) {
  return request<{ issue: Issue }>(`/${encodeURIComponent(id)}`);
}
export function listIssueMembers() {
  return request<{ members: IssueMember[] }>("/members");
}
export function createIssue(
  input: IssueInput,
  target?: { type: IssueTargetType; id: string; itemId?: string },
) {
  return request<{ issueId: string }>("", {
    method: "POST",
    body: JSON.stringify({ ...input, target }),
  });
}
export function updateIssue(
  id: string,
  input: Partial<IssueInput> & {
    expectedRevision: number;
    status?: Issue["status"];
  },
) {
  return request<{ issue: Issue }>(`/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetchApi(`${apiUrl}/api/issues${path}`, {
    credentials: "include",
    ...options,
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Could not load issues.");
  }
  return response.json() as Promise<T>;
}
export function issuePath(id: string) {
  return `/issues/${encodeURIComponent(id)}`;
}
export function transactionIssuePath(id: string) {
  return `/issues/new/transactions/${encodeURIComponent(id)}`;
}
