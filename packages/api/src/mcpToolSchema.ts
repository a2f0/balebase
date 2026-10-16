import type { JsonSchemaType } from "@modelcontextprotocol/server";
import type { ApiKeyAccess } from "./apiKeys";

/**
 * An MCP tool that calls one REST route. Path parameters, query parameters,
 * and JSON body fields share the tool's flat argument object; the REST route
 * validates them and its error message becomes the tool error.
 */
export interface McpTool {
  body?: { properties: Record<string, JsonSchemaType>; required?: string[] };
  description: string;
  /** Deletes or irreversibly changes data. */
  destructive?: boolean;
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  name: string;
  /** Reaches people or services outside Balebase, such as email or Checkr. */
  openWorld?: boolean;
  params?: Record<string, JsonSchemaType>;
  /** A REST path with `{name}` placeholders for `params`. */
  path: string;
  query?: Record<string, JsonSchemaType>;
  title: string;
  /** Trims a large REST response to what a model needs. */
  transform?: (body: unknown) => unknown;
}

/** Reads are available to every key; anything else needs a write key. */
export function toolAccess(tool: McpTool): ApiKeyAccess {
  return tool.method === "GET" ? "read" : "write";
}

export function toolInputSchema(tool: McpTool): JsonSchemaType {
  return {
    additionalProperties: false,
    properties: {
      ...tool.params,
      ...tool.query,
      ...tool.body?.properties,
    },
    required: [
      ...Object.keys(tool.params ?? {}),
      ...(tool.body?.required ?? []),
    ],
    type: "object",
  };
}

export function text(
  description: string,
  limits: { maxLength?: number; minLength?: number; pattern?: string } = {},
): JsonSchemaType {
  return { description, type: "string", ...limits };
}

export function id(description: string): JsonSchemaType {
  return { description, minLength: 1, type: "string" };
}

export function oneOf(
  description: string,
  values: readonly string[],
): JsonSchemaType {
  return { description, enum: [...values], type: "string" };
}

export function integer(
  description: string,
  limits: { maximum?: number; minimum?: number } = {},
): JsonSchemaType {
  return { description, type: "integer", ...limits };
}

export function boolean(description: string): JsonSchemaType {
  return { description, type: "boolean" };
}

export function date(description: string): JsonSchemaType {
  return { description, pattern: "^\\d{4}-\\d{2}-\\d{2}$", type: "string" };
}

/** Allows null alongside a scalar schema, which usually clears the value. */
export function nullable(schema: JsonSchemaType): JsonSchemaType {
  if (typeof schema !== "object" || typeof schema.type !== "string") {
    throw new Error("Only scalar schemas can be made nullable.");
  }
  const { enum: values, ...rest } = schema;
  return {
    ...rest,
    ...(values ? { enum: [...values, null] } : {}),
    type: [schema.type, "null"],
  };
}

export function list(
  description: string,
  items: JsonSchemaType,
  limits: { maxItems?: number; minItems?: number } = {},
): JsonSchemaType {
  return { description, items, type: "array", ...limits };
}

export function object(
  description: string,
  properties: Record<string, JsonSchemaType>,
  required: string[] = [],
): JsonSchemaType {
  return { description, properties, required, type: "object" };
}

export const activityCursor = text(
  "The nextCursor from the previous page; omit for the newest events.",
  { pattern: "^[1-9]\\d{0,15}$" },
);
