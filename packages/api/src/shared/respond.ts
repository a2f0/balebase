import type {
  JsonRoute,
  Route,
  RouteResponse,
} from "@balebase/validators/route";
import type { Context } from "hono";
import { routePath } from "hono/route";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/**
 * Reads a route's JSON body through its contract. Returns the parsed body, or
 * a 400 response naming the first rule it breaks: the rule's own message
 * when the contract gives one, otherwise `invalid`.
 */
export async function readBody<Body extends z.ZodType>(
  context: Context,
  contract: Route & { body: Body },
  invalid: string,
): Promise<z.output<Body> | Response> {
  const body: unknown = await context.req.json().catch(() => null);
  return parse(context, contract.body, body, invalid);
}

/**
 * Reads a route's query parameters through its contract, as `readBody`
 * reads a body. A parameter sent more than once counts once.
 */
export function readQuery<Query extends z.ZodType>(
  context: Context,
  contract: Route & { query: Query },
  invalid: string,
): z.output<Query> | Response {
  return parse(context, contract.query, context.req.query(), invalid);
}

function parse<Schema extends z.ZodType>(
  context: Context,
  schema: Schema,
  value: unknown,
  invalid: string,
): z.output<Schema> | Response {
  const parsed = schema.safeParse(value, { error: () => invalid });
  if (parsed.success) return parsed.data;
  return context.json(
    { error: parsed.error.issues[0]?.message ?? invalid },
    400,
  );
}

/** Set while tests run; production never checks a response. */
let mismatches: string[] | undefined;

/** Starts collecting contract mismatches into the given list. */
export function collectContractMismatches(list: string[]) {
  mismatches = list;
}

/**
 * Sends a route's JSON response, typed by its contract. Under test, the
 * response as serialized, and the request's query, are checked against it.
 */
export function respond<R extends JsonRoute>(
  context: Context,
  contract: R,
  body: RouteResponse<R>,
  status?: ContentfulStatusCode,
) {
  if (mismatches) check(context, contract, body, mismatches);
  return context.json(body as object, status);
}

function check(
  context: Context,
  contract: JsonRoute,
  body: unknown,
  list: string[],
) {
  const name = `${contract.method} ${contract.path}`;
  const served = routePath(context).replace(/\/$/, "");
  if (context.req.method !== contract.method || !contract.path.endsWith(served))
    list.push(`${name} answered ${context.req.method} ${routePath(context)}.`);
  const sent = contract.response.safeParse(JSON.parse(JSON.stringify(body)));
  if (!sent.success)
    list.push(`${name} response: ${z.prettifyError(sent.error)}`);
  const query = contract.query?.safeParse(context.req.query());
  if (query && !query.success)
    list.push(`${name} query: ${z.prettifyError(query.error)}`);
}
