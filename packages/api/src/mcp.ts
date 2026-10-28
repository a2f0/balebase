import { productName } from "@balebase/ui/brand";
import {
  type CallToolResult,
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { version } from "../package.json";
import type { ApiKeyAccess } from "./apiKeys";
import type { ApiEnv } from "./authMiddleware";
import { auditTools } from "./mcpAuditTools";
import { contractTools } from "./mcpContractTools";
import { financeTools } from "./mcpFinanceTools";
import { issueTools } from "./mcpIssueTools";
import { libraryTools } from "./mcpLibraryTools";
import { type McpTool, toolAccess, toolInputSchema } from "./mcpToolSchema";
import { workspaceTools } from "./mcpWorkspaceTools";

/** Runs a request through the API itself, with every route's own checks. */
export type ApiDispatch = (request: Request) => Response | Promise<Response>;

const toolListTtlMs = 5 * 60 * 1000;

export const mcpTools: McpTool[] = [
  ...workspaceTools,
  ...issueTools,
  ...auditTools,
  ...contractTools,
  ...libraryTools,
  ...financeTools,
];

/**
 * Serves MCP over Streamable HTTP: the stateless 2026-07-28 revision and,
 * through the SDK's stateless fallback, clients that still open with
 * `initialize`. Tools proxy to REST routes with the caller's API key, so the
 * key's access level and the creator's permissions apply exactly as they do
 * to direct API calls.
 */
export function handleMcpRequest(
  context: Context<ApiEnv>,
  dispatch: ApiDispatch,
) {
  const apiKey = context.get("apiKey");
  if (!apiKey) throw new Error("The MCP endpoint requires an API key.");
  const forward = {
    authorization: context.req.header("Authorization") ?? "",
    base: new URL(context.req.url).origin,
    dispatch,
  };
  const handler = createMcpHandler(() => createServer(apiKey.access, forward), {
    // The tool list never changes while a Worker runs, so there is nothing
    // to subscribe to; refusing listen streams keeps requests short-lived.
    maxSubscriptions: 0,
    onerror: (error) => console.warn("MCP request rejected.", error.message),
  });
  return handler.fetch(context.req.raw);
}

interface ForwardedRequest {
  authorization: string;
  base: string;
  dispatch: ApiDispatch;
}

function createServer(access: ApiKeyAccess, forward: ForwardedRequest) {
  const server = new McpServer(
    { name: "balebase", title: productName, version },
    {
      cacheHints: {
        "server/discover": { cacheScope: "private", ttlMs: toolListTtlMs },
        // Read keys see fewer tools than write keys.
        "tools/list": { cacheScope: "private", ttlMs: toolListTtlMs },
      },
      instructions: serverInstructions(access),
    },
  );
  for (const tool of mcpTools) {
    const toolNeeds = toolAccess(tool);
    if (toolNeeds === "write" && access !== "write") continue;
    server.registerTool(
      tool.name,
      {
        annotations: {
          destructiveHint: tool.destructive ?? false,
          idempotentHint:
            tool.method === "GET" ||
            tool.method === "PUT" ||
            tool.method === "DELETE",
          openWorldHint: tool.openWorld ?? false,
          readOnlyHint: toolNeeds === "read",
        },
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          toolInputSchema(tool),
        ),
        title: tool.title,
      },
      (args) => callTool(tool, args, forward),
    );
  }
  return server;
}

function serverInstructions(access: ApiKeyAccess) {
  return [
    `${productName} is an organization workspace: audits and checklists, equipment, contracts and e-signature, the shared inbox, the document library, finance, businesses, and employee forms.`,
    access === "write"
      ? "This API key can read and change data in one organization."
      : "This API key is read-only: it can read data in one organization but cannot change it.",
    "The key acts as the organization owner or admin who created it, so results follow that person's permissions; Finance tools also require membership in a group with Finance access.",
    "Find IDs with the list tools before calling get, update, or delete tools. Saving an audit run requires the expectedRevision from its latest get_audit_run result.",
  ].join(" ");
}

async function callTool(
  tool: McpTool,
  args: Record<string, unknown>,
  forward: ForwardedRequest,
): Promise<CallToolResult> {
  const response = await forward.dispatch(toolRequest(tool, args, forward));
  const text = await response.text();
  if (!response.ok) {
    return {
      content: [{ text: errorText(response.status, text), type: "text" }],
      isError: true,
    };
  }
  if (!text) return { content: [{ text: "Done.", type: "text" }] };
  const output = tool.transform
    ? JSON.stringify(tool.transform(JSON.parse(text)))
    : text;
  return { content: [{ text: output, type: "text" }] };
}

function toolRequest(
  tool: McpTool,
  args: Record<string, unknown>,
  forward: ForwardedRequest,
) {
  const path = tool.path.replace(/\{(\w+)\}/g, (_match, name: string) =>
    encodeURIComponent(String(args[name])),
  );
  const url = new URL(path, forward.base);
  for (const name of Object.keys(tool.query ?? {})) {
    const value = args[name];
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const headers = new Headers({ Authorization: forward.authorization });
  if (!tool.body) return new Request(url, { headers, method: tool.method });
  const body = Object.fromEntries(
    Object.keys(tool.body.properties)
      .filter((name) => args[name] !== undefined)
      .map((name) => [name, args[name]]),
  );
  headers.set("Content-Type", "application/json");
  return new Request(url, {
    body: JSON.stringify(body),
    headers,
    method: tool.method,
  });
}

function errorText(status: number, text: string) {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && "error" in body) {
      const { code, error } = body as { code?: unknown; error: unknown };
      const suffix = typeof code === "string" ? ` (${code})` : "";
      return `Request failed with status ${status}: ${String(error)}${suffix}`;
    }
  } catch {
    // Fall through to the raw body.
  }
  return `Request failed with status ${status}.${text ? ` ${text}` : ""}`;
}
