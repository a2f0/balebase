import type {
  IssueInput,
  IssueTargetType,
  IssueUpdate,
  issuesRoutes,
} from "@balebase/validators/issues";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof issuesRoutes.list>({
    method: "GET",
    path: "/api/issues",
    response: "json",
  }),
  members: endpoint<typeof issuesRoutes.members>({
    method: "GET",
    path: "/api/issues/members",
    response: "json",
  }),
  get: endpoint<typeof issuesRoutes.get>({
    method: "GET",
    path: "/api/issues/:id",
    response: "json",
  }),
  activity: endpoint<typeof issuesRoutes.activity>({
    method: "GET",
    path: "/api/issues/:id/activity",
    response: "json",
  }),
  create: endpoint<typeof issuesRoutes.create>({
    method: "POST",
    path: "/api/issues",
    body: "json",
    response: "json",
  }),
  update: endpoint<typeof issuesRoutes.update>({
    method: "PATCH",
    path: "/api/issues/:id",
    body: "json",
    response: "json",
  }),
};

export interface IssueFilters {
  q: string;
  status: "all" | "open" | "resolved";
  targetId?: string;
  type: "all" | IssueTargetType;
}

export function issuesApi(transport: Transport) {
  return {
    list(filters: IssueFilters, cursor?: string) {
      return transport.call(endpoints.list, {
        query: { ...filters, cursor },
      });
    },
    get(id: string) {
      return transport.call(endpoints.get, { params: { id } });
    },
    members() {
      return transport.call(endpoints.members);
    },
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    create(
      input: IssueInput,
      target?: { id: string; itemId?: string; type: IssueTargetType },
    ) {
      return transport.call(endpoints.create, {
        body: { ...input, target },
      });
    },
    update(id: string, update: IssueUpdate) {
      return transport.call(endpoints.update, {
        body: update,
        params: { id },
      });
    },
  };
}
