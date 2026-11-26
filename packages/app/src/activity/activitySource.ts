import type { ActivityResourceType } from "@balebase/validators/activity";
import { balebase } from "../balebase";

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
  if (!source) return balebase().api.activity.list(cursor, resourceType);
  const { id } = source;
  switch (source.type) {
    case "admin_organization":
      return balebase().api.adminOrganizations.activity(id, cursor);
    case "admin_purges":
      return balebase().api.adminJobs.purges(cursor);
    case "form_run":
      return balebase().api.forms.runActivity(id, cursor);
    case "form_template":
      return balebase().api.forms.templateActivity(id, cursor);
    case "business":
      return balebase().api.businesses.activity(id, cursor);
    case "contract_template":
      return balebase().api.contractTemplates.activity(id, cursor);
    case "employee_requirement":
      return balebase().api.employeeForms.activity(id, cursor);
    case "equipment":
      return balebase().api.equipment.activity(id, cursor);
    case "finance_connection":
      return balebase().api.finance.connectionActivity(id, cursor);
    case "finance_transaction":
      return balebase().api.finance.transactionActivity(id, cursor);
    case "global_form_template":
      return balebase().api.adminFormTemplates.activity(id, cursor);
    case "inbound_email":
      return balebase().api.inbox.activity(id, cursor);
    case "issue":
      return balebase().api.issues.activity(id, cursor);
    case "library_file":
      return balebase().api.objects.activity(id, cursor);
    case "library_folder":
      return balebase().api.libraryFolders.activity(id, cursor);
    case "organization_group":
      return balebase().api.organizationGroups.activity(id, cursor);
    case "project":
      return balebase().api.projects.activity(id, cursor);
  }
}
