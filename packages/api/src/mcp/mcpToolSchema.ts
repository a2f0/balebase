import type { ApiKeyAccess } from "@balebase/validators/apiKeys";
import type { Route } from "@balebase/validators/route";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * An MCP tool that calls one contract route. Its arguments are the route's
 * path parameters, query parameters, and JSON body fields in one flat
 * object, with schemas generated from the contract; the REST route
 * validates them and its error message becomes the tool error.
 */
export interface McpTool {
  description: string;
  /**
   * What each argument means to a model, by name. A dotted name, such as
   * `recipients.email`, describes a field inside an argument.
   */
  descriptions?: Record<string, string>;
  /** Deletes or irreversibly changes data. */
  destructive?: boolean;
  name: string;
  /** Query parameters and body fields the tool does not offer. */
  omit?: string[];
  /** Reaches people or services outside Balebase, such as email or Checkr. */
  openWorld?: boolean;
  /**
   * Optional route fields a model must send anyway, such as the version that
   * keeps a save from overwriting newer edits.
   */
  require?: string[];
  route: Route;
  title: string;
  /** Trims a large REST response to what a model needs. */
  transform?: (body: unknown) => unknown;
}

/** Where each argument goes in the REST request, and the schema clients see. */
export interface ToolInput {
  /** Absent when the route takes no JSON body. */
  body?: string[];
  params: string[];
  query: string[];
  schema: JsonSchemaType;
}

interface SchemaNode {
  [keyword: string]: unknown;
  anyOf?: SchemaNode[];
  description?: string;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

/** Reads are available to every key; anything else needs a write key. */
export function toolAccess(tool: McpTool): ApiKeyAccess {
  return tool.route.method === "GET" ? "read" : "write";
}

export function toolInput(tool: McpTool): ToolInput {
  const { body, path, query } = tool.route;
  if (body === "file" || body === "form") {
    throw new Error(`${tool.name} cannot send a ${body} body.`);
  }
  const omitted = new Set(tool.omit);
  const params = [...path.matchAll(/:(\w+)/g)].map((match) => match[1] ?? "");
  const queryFields = contractFields(query, omitted);
  const bodyFields = contractFields(body, omitted);
  const properties: Record<string, SchemaNode> = Object.fromEntries(
    params.map((name) => [name, { minLength: 1, type: "string" }]),
  );
  for (const [name, schema] of [
    ...Object.entries(queryFields.properties ?? {}),
    ...Object.entries(bodyFields.properties ?? {}),
  ]) {
    if (name in properties) {
      throw new Error(`${tool.name} has two arguments named ${name}.`);
    }
    properties[name] = schema;
  }
  for (const name of tool.require ?? []) {
    if (!(name in properties)) {
      throw new Error(`${tool.name} cannot require missing ${name}.`);
    }
  }
  const schema = {
    additionalProperties: false,
    properties,
    required: [
      ...params,
      ...(queryFields.required ?? []),
      ...(bodyFields.required ?? []),
      ...(tool.require ?? []),
    ],
    type: "object",
  };
  describeArguments(tool, schema);
  return {
    ...(body ? { body: Object.keys(bodyFields.properties ?? {}) } : {}),
    params,
    query: Object.keys(queryFields.properties ?? {}),
    schema: schema as JsonSchemaType,
  };
}

function describeArguments(tool: McpTool, schema: SchemaNode) {
  for (const [name, description] of Object.entries(tool.descriptions ?? {})) {
    const fields = fieldsAt(schema, name.split("."));
    if (fields.length === 0) {
      throw new Error(`${tool.name} has no argument ${name}.`);
    }
    for (const field of fields) field.description = description;
  }
}

/** A contract schema's fields as clients send them, less `omitted`. */
function contractFields(
  schema: z.ZodType | undefined,
  omitted: ReadonlySet<string>,
): SchemaNode {
  if (!schema) return {};
  // The round trip detaches any node zod shares between fields, so a
  // description given to one field never lands on another.
  const { properties = {}, required = [] }: SchemaNode = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { io: "input" })),
  );
  return {
    properties: Object.fromEntries(
      Object.entries(properties).filter(([name]) => !omitted.has(name)),
    ),
    required: required.filter((name) => !omitted.has(name)),
  };
}

/** The fields at a path of names, looking inside arrays and unions. */
function fieldsAt(schema: SchemaNode, path: string[]) {
  let nodes = [schema];
  for (const name of path) {
    nodes = nodes.flatMap(objectsWithin).flatMap((node) => {
      const field = node.properties?.[name];
      return field ? [field] : [];
    });
  }
  return nodes;
}

function objectsWithin(node: SchemaNode): SchemaNode[] {
  return [
    ...(node.properties ? [node] : []),
    ...(node.items ? objectsWithin(node.items) : []),
    ...[...(node.anyOf ?? []), ...(node.oneOf ?? [])].flatMap(objectsWithin),
  ];
}

export const activityCursor = {
  cursor: "The nextCursor from the previous page; omit for the newest events.",
};
