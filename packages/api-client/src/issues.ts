import {
  type IssueInput,
  type IssueTargetType,
  type IssueUpdate,
  issuesRoutes,
} from "@balebase/validators/issues";
import type { Transport } from "./transport";

export interface IssueFilters {
  q: string;
  status: "all" | "open" | "resolved";
  targetId?: string;
  type: "all" | IssueTargetType;
}

export function issuesApi(transport: Transport) {
  return {
    list(filters: IssueFilters, cursor?: string) {
      return transport.call(issuesRoutes.list, {
        query: { ...filters, cursor },
      });
    },
    get(id: string) {
      return transport.call(issuesRoutes.get, { params: { id } });
    },
    members() {
      return transport.call(issuesRoutes.members);
    },
    activity(id: string, cursor?: string) {
      return transport.call(issuesRoutes.activity, {
        params: { id },
        query: { cursor },
      });
    },
    create(
      input: IssueInput,
      target?: { id: string; itemId?: string; type: IssueTargetType },
    ) {
      return transport.call(issuesRoutes.create, {
        body: { ...input, target },
      });
    },
    update(id: string, update: IssueUpdate) {
      return transport.call(issuesRoutes.update, {
        body: update,
        params: { id },
      });
    },
  };
}
