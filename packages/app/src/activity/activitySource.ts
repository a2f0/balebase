import type { ActivityResourceType } from "@balebase/validators/activity";
import { api } from "../shared/apiClient";

export type ActivitySource =
  | {
      id: string;
      type:
        | "admin_organization"
        | "audit_run"
        | "audit_template"
        | "equipment"
        | "issue"
        | "project"
        | "finance_transaction"
        | "global_audit_template";
    }
  | undefined;

/**
 * One page of a record's history, or the organization's without a source. A
 * global form's history is read through Global Audits, when managing it, and
 * an organization's own history by root admins through its admin page.
 */
export function listActivity(
  source?: ActivitySource,
  cursor?: string,
  resourceType?: ActivityResourceType,
) {
  if (!source) return api.activity.list(cursor, resourceType);
  const { id } = source;
  switch (source.type) {
    case "admin_organization":
      return api.adminOrganizations.activity(id, cursor);
    case "audit_run":
      return api.audits.runActivity(id, cursor);
    case "audit_template":
      return api.audits.templateActivity(id, cursor);
    case "equipment":
      return api.equipment.activity(id, cursor);
    case "finance_transaction":
      return api.finance.transactionActivity(id, cursor);
    case "global_audit_template":
      return api.adminAuditTemplates.activity(id, cursor);
    case "issue":
      return api.issues.activity(id, cursor);
    case "project":
      return api.projects.activity(id, cursor);
  }
}
