import { z } from "zod";

/**
 * Every API error body: a message people can read, and sometimes a code the
 * client branches on, such as `UPGRADE_REQUIRED`. Some errors add fields of
 * their own, such as the invitation a failed assignment left behind.
 */
export const ErrorBodySchema = z.looseObject({
  code: z.string().optional(),
  error: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

type Method = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

/**
 * One API route, as both sides see it. The API sends its JSON responses
 * through the route, and tests check them against `response`; the client
 * builds its requests from it.
 */
export interface Route {
  method: Method;
  /** The full path the API serves, with `:name` segments for parameters. */
  path: string;
  /**
   * `omit` for a public route that a token in its path authorizes, such as a
   * signer's link, so the request carries no cookies. Others send them.
   */
  credentials?: "omit";
  /** Query parameters, as the client sends them. */
  query?: z.ZodType;
  /**
   * A JSON body; `form` for a multipart upload; `file` for one file sent as
   * the whole body with its own content type.
   */
  body?: z.ZodType | "file" | "form";
  /**
   * A JSON response; `file` for a download the caller reads as a Response;
   * `empty` for a route that answers 204 with no body.
   */
  response: z.ZodType | "empty" | "file";
}

export type JsonRoute = Route & { response: z.ZodType };

export function route<const R extends Route>(definition: R): R {
  return definition;
}

type ParamNames<Path extends string> =
  Path extends `${string}:${infer Name}/${infer Rest}`
    ? Name | ParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Name}`
      ? Name
      : never;

export type PathParams<Path extends string> = {
  [Name in ParamNames<Path>]: string;
};

type ParamsInput<R extends Route> = [ParamNames<R["path"]>] extends [never]
  ? unknown
  : { params: PathParams<R["path"]> };

type QueryInput<R extends Route> = R["query"] extends z.ZodType
  ? { query?: z.input<R["query"]> }
  : unknown;

type BodyInput<R extends Route> = R["body"] extends z.ZodType
  ? { body: z.input<R["body"]> }
  : R["body"] extends "form"
    ? { body: FormData }
    : R["body"] extends "file"
      ? { body: Blob }
      : unknown;

/** What a caller passes to reach a route. */
export type RouteInput<R extends Route> = ParamsInput<R> &
  QueryInput<R> &
  BodyInput<R>;

/** What a route resolves to once its response arrives. */
export type RouteOutput<R extends Route> = R["response"] extends z.ZodType
  ? z.output<R["response"]>
  : R["response"] extends "file"
    ? Response
    : undefined;

/** The JSON body a route's handler sends. */
export type RouteResponse<R extends JsonRoute> = z.input<R["response"]>;
