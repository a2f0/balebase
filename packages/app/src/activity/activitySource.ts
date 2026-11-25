import type { ActivityResourceType } from "@balebase/validators/activity";
import { api } from "../shared/apiClient";

export type ActivitySource =
  | {
      id: string;
      type:
        | "admin_organization"
        | "admin_purges"
        | "form_run"
        | "form_template"
        | "business"
        | "contract_template"
        | "employee_requirement"
        | "equipment"
        | "issue"
        | "project"
        | "finance_connection"
        | "finance_transaction"
        | "global_form_template"
        | "inbound_email"
        | "library_file"
        | "library_folder"
        | "organization_group";
    }
  | undefined;

/**
 * One page of a record's history, or the organization's without a source. A
 * global form's history is read through Global templates, when managing it, and
 * an organization's own history by root admins through its admin page, and
 * the purge history of accounts and organizations on the admin Jobs page.
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
    case "admin_purges":
      return api.adminJobs.purges(cursor);
    case "form_run":
      return api.forms.runActivity(id, cursor);
    case "form_template":
      return api.forms.templateActivity(id, cursor);
    case "business":
      return api.businesses.activity(id, cursor);
    case "contract_template":
      return api.contractTemplates.activity(id, cursor);
    case "employee_requirement":
      return api.employeeForms.activity(id, cursor);
    case "equipment":
      return api.equipment.activity(id, cursor);
    case "finance_connection":
      return api.finance.connectionActivity(id, cursor);
    case "finance_transaction":
      return api.finance.transactionActivity(id, cursor);
    case "global_form_template":
      return api.adminFormTemplates.activity(id, cursor);
    case "inbound_email":
      return api.inbox.activity(id, cursor);
    case "issue":
      return api.issues.activity(id, cursor);
    case "library_file":
      return api.objects.activity(id, cursor);
    case "library_folder":
      return api.libraryFolders.activity(id, cursor);
    case "organization_group":
      return api.organizationGroups.activity(id, cursor);
    case "project":
      return api.projects.activity(id, cursor);
  }
}
