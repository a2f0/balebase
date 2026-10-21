import type { Route } from "@balebase/validators/route";
import type { z } from "zod";

type EndpointBody<R extends Route> = R["body"] extends z.ZodType
  ? { body: "json" }
  : R["body"] extends "file" | "form"
    ? { body: R["body"] }
    : { body?: never };

type EndpointCredentials<R extends Route> = R["credentials"] extends "omit"
  ? { credentials: "omit" }
  : { credentials?: never };

/**
 * What the client needs of a route to send it: no schemas, so zod stays out
 * of the app bundle. The route's contract types it, so a method, path, or
 * body kind that disagrees with the contract fails to compile.
 */
export type Endpoint<R extends Route> = EndpointBody<R> &
  EndpointCredentials<R> & {
    method: R["method"];
    path: R["path"];
    response: R["response"] extends z.ZodType ? "json" : R["response"];
    /** Carries the route's type for inference; never set. */
    readonly route?: R;
  };

export function endpoint<R extends Route>(shape: Endpoint<R>) {
  return shape;
}
