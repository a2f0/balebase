import { productName } from "@balebase/ui/brand";
import { contractsRoutes } from "@balebase/validators/contracts";
import { contractTemplatesRoutes } from "@balebase/validators/contractTemplates";
import { employeeFormsRoutes } from "@balebase/validators/employeeForms";
import { activityCursor, type McpTool } from "./mcpToolSchema";

/** A field box on a page, with coordinates as fractions of the page. */
function placedField(
  path: string,
  ownerKey: "recipientKey" | "roleKey",
  owner: string,
) {
  return {
    [`${path}.height`]: "Height as a fraction of the page height.",
    [`${path}.label`]: "Optional label.",
    [`${path}.page`]: "Page number, starting at 1.",
    [`${path}.${ownerKey}`]: `The ${owner} key that fills this field.`,
    [`${path}.required`]: "Only text fields can be optional.",
    [`${path}.type`]: "Field type.",
    [`${path}.width`]: "Width as a fraction of the page width.",
    [`${path}.x`]: "Left edge as a fraction of the page width.",
    [`${path}.y`]: "Top edge as a fraction of the page height.",
  };
}

const signingOrder =
  "parallel emails every signer at once; sequential emails each routing order after the previous one signs.";
const reminderIntervalDays =
  "Days between automatic reminders, or null for none.";
const contractId = { id: "Contract id from list_contracts." };
const templateId = {
  id: "Contract template id from list_contract_templates.",
};
const requirementId = {
  id: "Requirement id from list_employee_requirements.",
};

export const contractTools: McpTool[] = [
  {
    description:
      "Lists contracts with status, due date, sender, and how many signers have signed.",
    name: "list_contracts",
    route: contractsRoutes.list,
    title: "List contracts",
  },
  {
    description:
      "Gets a contract: its document details, recipients and their signing status, placed fields, and audit trail.",
    descriptions: contractId,
    name: "get_contract",
    route: contractsRoutes.get,
    title: "Get contract",
  },
  {
    description:
      "Replaces a draft contract's title, message, signers, and fields. Only drafts can be edited. Upload new PDFs in the app.",
    descriptions: {
      ...contractId,
      dueDate: "Due date as YYYY-MM-DD, or null.",
      fields:
        "Every field on the document. This replaces the saved fields. x + width and y + height must not exceed 1.",
      ...placedField("fields", "recipientKey", "recipient"),
      message: "Message emailed to signers.",
      recipients: "Every signer. This replaces the saved recipients.",
      "recipients.email": "Email address.",
      "recipients.key":
        "Any unique key for this signer, such as their recipient id from get_contract. Fields refer to it.",
      "recipients.name": "Full name.",
      "recipients.routingOrder": "Signing step for sequential contracts.",
      reminderIntervalDays,
      signingOrder,
      title: "Contract title.",
    },
    name: "save_contract_draft",
    route: contractsRoutes.saveDraft,
    title: "Save contract draft",
  },
  {
    description:
      "Sends a draft contract for signature and emails the first signers. Every signer needs a name, valid email, and a signature field.",
    descriptions: contractId,
    name: "send_contract",
    openWorld: true,
    route: contractsRoutes.send,
    title: "Send contract",
  },
  {
    description:
      "Emails a reminder to signers who have not signed a sent contract. Each signer can be reminded once an hour.",
    descriptions: contractId,
    name: "remind_contract_signers",
    openWorld: true,
    route: contractsRoutes.remind,
    title: "Remind contract signers",
  },
  {
    description:
      "Voids a sent contract, invalidating its signing links and notifying signers who have not signed.",
    descriptions: {
      ...contractId,
      reason: "Why the contract is voided; shared with signers.",
    },
    destructive: true,
    name: "void_contract",
    openWorld: true,
    route: contractsRoutes.void,
    title: "Void contract",
  },
  {
    description:
      "Deletes a draft, completed, declined, or voided contract. Void a sent contract first.",
    descriptions: contractId,
    destructive: true,
    name: "delete_contract",
    route: contractsRoutes.delete,
    title: "Delete contract",
  },
  {
    description: "Lists reusable contract templates.",
    name: "list_contract_templates",
    route: contractTemplatesRoutes.list,
    title: "List contract templates",
  },
  {
    description:
      "Gets a contract template version: its signer roles, placed fields, message, and signing order.",
    descriptions: {
      ...templateId,
      version: "Version to read; defaults to the current one.",
    },
    name: "get_contract_template",
    route: contractTemplatesRoutes.get,
    title: "Get contract template",
  },
  {
    description: "Lists a contract template's versions, newest first.",
    descriptions: templateId,
    name: "list_contract_template_versions",
    route: contractTemplatesRoutes.versions,
    title: "List contract template versions",
  },
  {
    description:
      "Lists one contract template's history, newest first, 50 events per page: who created it and saved each version, and through which API key. Pass nextCursor to page.",
    descriptions: { ...templateId, ...activityCursor },
    name: "list_contract_template_activity",
    route: contractTemplatesRoutes.activity,
    title: "List contract template activity",
  },
  {
    description:
      "Saves a new version of a contract template. Earlier versions and contracts made from them do not change.",
    descriptions: {
      ...templateId,
      definition:
        "Signer roles, fields, and sending defaults for the new version.",
      "definition.fields":
        "Every field, owned by a role. x + width and y + height must not exceed 1.",
      ...placedField("definition.fields", "roleKey", "role"),
      "definition.message": "Default message to signers.",
      "definition.reminderIntervalDays": reminderIntervalDays,
      "definition.roles": "Signer roles, such as Employee and Company.",
      "definition.roles.key": "Unique role key; fields refer to it.",
      "definition.roles.label": "Role name, unique in the template.",
      "definition.roles.routingOrder": "Signing step for sequential use.",
      "definition.signingOrder": signingOrder,
      description: "Template description; may be empty.",
      expectedCurrentVersion:
        "currentVersion from get_contract_template; rejected if a newer version exists.",
      name: "Template name.",
      sourceVersion: "Version whose PDF the new version reuses.",
    },
    name: "save_contract_template_version",
    route: contractTemplatesRoutes.saveVersion,
    title: "Save contract template version",
  },
  {
    description:
      "Creates a draft contract from a template version with people assigned to its roles. Review it, then call send_contract.",
    descriptions: {
      ...templateId,
      dueDate: "Due date as YYYY-MM-DD, or null.",
      recipients: "Exactly one person per template role.",
      "recipients.email": "Email address.",
      "recipients.name": "Full name.",
      "recipients.roleKey": "Role key from get_contract_template.",
      title: "Contract title; defaults to the template name.",
      version: "Template version to use.",
    },
    name: "create_contract_from_template",
    route: contractTemplatesRoutes.createContract,
    title: "Create contract from template",
  },
  {
    description:
      "Deletes a contract template. Contracts already made from it are unaffected.",
    descriptions: templateId,
    destructive: true,
    name: "delete_contract_template",
    route: contractTemplatesRoutes.delete,
    title: "Delete contract template",
  },
  {
    description:
      "Lists employee requirements (forms, background checks, credit checks) with due dates, status, uploads, and Checkr progress.",
    name: "list_employee_requirements",
    // The key's creator manages requirements; their own list is the app's.
    omit: ["for"],
    route: employeeFormsRoutes.list,
    title: "List employee requirements",
  },
  {
    description:
      "Assigns forms or screenings to one member or pending invitation. Send exactly one of memberId and invitationId.",
    descriptions: {
      invitationId:
        "A pending invitation id from list_people; use instead of memberId.",
      memberId:
        "The member id (not user id) from list_people; use instead of invitationId.",
      requirements: "Requirements to assign.",
      "requirements.dueDate": "Due date as YYYY-MM-DD.",
      "requirements.kind": "Requirement kind.",
      "requirements.title": "Title, such as W-4.",
    },
    name: "assign_employee_requirements",
    route: employeeFormsRoutes.create,
    title: "Assign employee requirements",
  },
  {
    description:
      "Changes a requirement's status or due date. Status cannot change while a screening is submitted to Checkr.",
    descriptions: {
      ...requirementId,
      documentRevision:
        "documentRevision from list_employee_requirements; required to change a form's status.",
      dueDate: "New due date as YYYY-MM-DD.",
      status:
        "Forms use pending, submitted, or complete (complete needs an upload); screenings use pending, in_progress, or complete.",
    },
    name: "update_employee_requirement",
    route: employeeFormsRoutes.update,
    title: "Update employee requirement",
  },
  {
    description:
      "Lists one employee requirement's history, newest first, 50 events per page: assignment, due date and status changes, uploads, and background check requests. Organization owners and admins only. Pass nextCursor to page.",
    descriptions: { ...requirementId, ...activityCursor },
    name: "list_employee_requirement_activity",
    route: employeeFormsRoutes.activity,
    title: "List employee requirement activity",
  },
  {
    description:
      "Deletes a requirement and its upload. Requirements with a screening submitted to Checkr cannot be deleted.",
    descriptions: requirementId,
    destructive: true,
    name: "delete_employee_requirement",
    route: employeeFormsRoutes.delete,
    title: "Delete employee requirement",
  },
  {
    description: `Requests a Checkr background check at a work location. ${productName} emails the person, who reviews the disclosures, enters their details, and signs the authorization in the app; ${productName} then orders the report. Credit checks are tracked manually.`,
    descriptions: {
      ...requirementId,
      city: "Optional work city.",
      state: "Two-letter uppercase US work state, such as CA.",
    },
    name: "request_checkr_screening",
    openWorld: true,
    route: employeeFormsRoutes.requestScreening,
    title: "Request Checkr screening",
  },
  {
    description:
      "Fetches the latest Checkr report status for a submitted screening.",
    descriptions: requirementId,
    name: "refresh_checkr_screening",
    openWorld: true,
    route: employeeFormsRoutes.refreshScreening,
    title: "Refresh Checkr screening",
  },
];
