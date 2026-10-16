import type { JsonSchemaType } from "@modelcontextprotocol/server";
import {
  boolean,
  date,
  id,
  integer,
  list,
  type McpTool,
  nullable,
  object,
  oneOf,
  text,
} from "./mcpToolSchema";

const fieldTypes = [
  "signature",
  "initials",
  "date_signed",
  "name",
  "text",
] as const;

function fraction(description: string): JsonSchemaType {
  return { description, maximum: 1, minimum: 0, type: "number" };
}

/** A field box on a page, with coordinates as fractions of the page. */
function placedField(ownerKey: "recipientKey" | "roleKey", owner: string) {
  return object(
    "A field placed on the PDF. x + width and y + height must not exceed 1.",
    {
      height: fraction("Height as a fraction of the page height."),
      label: nullable(text("Optional label.", { maxLength: 100 })),
      page: integer("Page number, starting at 1.", { minimum: 1 }),
      [ownerKey]: text(`The ${owner} key that fills this field.`, {
        maxLength: 100,
        minLength: 1,
      }),
      required: boolean("Only text fields can be optional."),
      type: oneOf("Field type.", fieldTypes),
      width: fraction("Width as a fraction of the page width."),
      x: fraction("Left edge as a fraction of the page width."),
      y: fraction("Top edge as a fraction of the page height."),
    },
    [ownerKey, "type", "page", "x", "y", "width", "height"],
  );
}

const signingOrder = oneOf(
  "parallel emails every signer at once; sequential emails each routing order after the previous one signs.",
  ["parallel", "sequential"],
);
const reminderIntervalDays = nullable(
  integer("Days between automatic reminders, or null for none.", {
    maximum: 30,
    minimum: 1,
  }),
);
const contractId = id("Contract id from list_contracts.");
const templateId = id("Contract template id from list_contract_templates.");
const requirementId = id("Requirement id from list_employee_requirements.");

export const contractTools: McpTool[] = [
  {
    description:
      "Lists contracts with status, due date, sender, and how many signers have signed.",
    method: "GET",
    name: "list_contracts",
    path: "/api/contracts",
    title: "List contracts",
  },
  {
    description:
      "Gets a contract: its document details, recipients and their signing status, placed fields, and audit trail.",
    method: "GET",
    name: "get_contract",
    params: { id: contractId },
    path: "/api/contracts/{id}",
    title: "Get contract",
  },
  {
    body: {
      properties: {
        dueDate: nullable(date("Due date as YYYY-MM-DD, or null.")),
        fields: list(
          "Every field on the document. This replaces the saved fields.",
          placedField("recipientKey", "recipient"),
          { maxItems: 500 },
        ),
        message: text("Message emailed to signers.", { maxLength: 2000 }),
        recipients: list(
          "Every signer. This replaces the saved recipients.",
          object(
            "A signer.",
            {
              email: text("Email address.", { maxLength: 254 }),
              key: text(
                "Any unique key for this signer, such as their recipient id from get_contract. Fields refer to it.",
                { maxLength: 100, minLength: 1 },
              ),
              name: text("Full name.", { maxLength: 120 }),
              routingOrder: integer("Signing step for sequential contracts.", {
                maximum: 20,
                minimum: 1,
              }),
            },
            ["key", "name", "email", "routingOrder"],
          ),
          { maxItems: 20 },
        ),
        reminderIntervalDays,
        signingOrder,
        title: text("Contract title.", { maxLength: 200, minLength: 1 }),
      },
      required: ["title", "signingOrder", "recipients", "fields"],
    },
    description:
      "Replaces a draft contract's title, message, signers, and fields. Only drafts can be edited. Upload new PDFs in the app.",
    method: "PUT",
    name: "save_contract_draft",
    params: { id: contractId },
    path: "/api/contracts/{id}/draft",
    title: "Save contract draft",
  },
  {
    description:
      "Sends a draft contract for signature and emails the first signers. Every signer needs a name, valid email, and a signature field.",
    method: "POST",
    name: "send_contract",
    openWorld: true,
    params: { id: contractId },
    path: "/api/contracts/{id}/send",
    title: "Send contract",
  },
  {
    description:
      "Emails a reminder to signers who have not signed a sent contract. Each signer can be reminded once an hour.",
    method: "POST",
    name: "remind_contract_signers",
    openWorld: true,
    params: { id: contractId },
    path: "/api/contracts/{id}/remind",
    title: "Remind contract signers",
  },
  {
    body: {
      properties: {
        reason: text("Why the contract is voided; shared with signers.", {
          maxLength: 500,
        }),
      },
    },
    description:
      "Voids a sent contract, invalidating its signing links and notifying signers who have not signed.",
    destructive: true,
    method: "POST",
    name: "void_contract",
    openWorld: true,
    params: { id: contractId },
    path: "/api/contracts/{id}/void",
    title: "Void contract",
  },
  {
    description:
      "Deletes a draft, completed, declined, or voided contract. Void a sent contract first.",
    destructive: true,
    method: "DELETE",
    name: "delete_contract",
    params: { id: contractId },
    path: "/api/contracts/{id}",
    title: "Delete contract",
  },
  {
    description: "Lists reusable contract templates.",
    method: "GET",
    name: "list_contract_templates",
    path: "/api/contracts/templates",
    title: "List contract templates",
  },
  {
    description:
      "Gets a contract template version: its signer roles, placed fields, message, and signing order.",
    method: "GET",
    name: "get_contract_template",
    params: { id: templateId },
    path: "/api/contracts/templates/{id}",
    query: {
      version: integer("Version to read; defaults to the current one.", {
        minimum: 1,
      }),
    },
    title: "Get contract template",
  },
  {
    description: "Lists a contract template's versions, newest first.",
    method: "GET",
    name: "list_contract_template_versions",
    params: { id: templateId },
    path: "/api/contracts/templates/{id}/versions",
    title: "List contract template versions",
  },
  {
    body: {
      properties: {
        definition: object(
          "Signer roles, fields, and sending defaults for the new version.",
          {
            fields: list(
              "Every field, owned by a role.",
              placedField("roleKey", "role"),
              { maxItems: 500 },
            ),
            message: text("Default message to signers.", { maxLength: 2000 }),
            reminderIntervalDays,
            roles: list(
              "Signer roles, such as Employee and Company.",
              object(
                "A role.",
                {
                  key: text("Unique role key; fields refer to it.", {
                    maxLength: 100,
                    minLength: 1,
                  }),
                  label: text("Role name, unique in the template.", {
                    maxLength: 120,
                    minLength: 1,
                  }),
                  routingOrder: integer("Signing step for sequential use.", {
                    maximum: 20,
                    minimum: 1,
                  }),
                },
                ["key", "label", "routingOrder"],
              ),
              { maxItems: 20, minItems: 1 },
            ),
            signingOrder,
          },
          ["roles", "fields", "signingOrder"],
        ),
        description: text("Template description; may be empty.", {
          maxLength: 2000,
        }),
        expectedCurrentVersion: integer(
          "currentVersion from get_contract_template; rejected if a newer version exists.",
          { minimum: 1 },
        ),
        name: text("Template name.", { maxLength: 200, minLength: 1 }),
        sourceVersion: integer("Version whose PDF the new version reuses.", {
          minimum: 1,
        }),
      },
      required: [
        "sourceVersion",
        "expectedCurrentVersion",
        "name",
        "description",
        "definition",
      ],
    },
    description:
      "Saves a new version of a contract template. Earlier versions and contracts made from them do not change.",
    method: "POST",
    name: "save_contract_template_version",
    params: { id: templateId },
    path: "/api/contracts/templates/{id}/versions",
    title: "Save contract template version",
  },
  {
    body: {
      properties: {
        dueDate: nullable(date("Due date as YYYY-MM-DD, or null.")),
        recipients: list(
          "Exactly one person per template role.",
          object(
            "The person filling a role.",
            {
              email: text("Email address.", { maxLength: 254, minLength: 3 }),
              name: text("Full name.", { maxLength: 120, minLength: 1 }),
              roleKey: text("Role key from get_contract_template.", {
                minLength: 1,
              }),
            },
            ["roleKey", "name", "email"],
          ),
          { minItems: 1 },
        ),
        title: text("Contract title; defaults to the template name.", {
          maxLength: 200,
          minLength: 1,
        }),
        version: integer("Template version to use.", { minimum: 1 }),
      },
      required: ["version", "recipients"],
    },
    description:
      "Creates a draft contract from a template version with people assigned to its roles. Review it, then call send_contract.",
    method: "POST",
    name: "create_contract_from_template",
    params: { id: templateId },
    path: "/api/contracts/templates/{id}/contracts",
    title: "Create contract from template",
  },
  {
    description:
      "Deletes a contract template. Contracts already made from it are unaffected.",
    destructive: true,
    method: "DELETE",
    name: "delete_contract_template",
    params: { id: templateId },
    path: "/api/contracts/templates/{id}",
    title: "Delete contract template",
  },
  {
    description:
      "Lists employee requirements (forms, background checks, credit checks) with due dates, status, uploads, and Checkr progress.",
    method: "GET",
    name: "list_employee_requirements",
    path: "/api/employee-forms",
    title: "List employee requirements",
  },
  {
    body: {
      properties: {
        invitationId: id(
          "A pending invitation id from list_people; use instead of memberId.",
        ),
        memberId: id(
          "The member id (not user id) from list_people; use instead of invitationId.",
        ),
        requirements: list(
          "Requirements to assign.",
          object(
            "A requirement.",
            {
              dueDate: date("Due date as YYYY-MM-DD."),
              kind: oneOf("Requirement kind.", [
                "form",
                "background_check",
                "credit_check",
              ]),
              title: text("Title, such as W-4.", {
                maxLength: 100,
                minLength: 1,
              }),
            },
            ["kind", "title", "dueDate"],
          ),
          { maxItems: 20, minItems: 1 },
        ),
      },
      required: ["requirements"],
    },
    description:
      "Assigns forms or screenings to one member or pending invitation. Send exactly one of memberId and invitationId.",
    method: "POST",
    name: "assign_employee_requirements",
    path: "/api/employee-forms",
    title: "Assign employee requirements",
  },
  {
    body: {
      properties: {
        documentRevision: integer(
          "documentRevision from list_employee_requirements; required to change a form's status.",
          { minimum: 0 },
        ),
        dueDate: date("New due date as YYYY-MM-DD."),
        status: oneOf(
          "Forms use pending, submitted, or complete (complete needs an upload); screenings use pending, in_progress, or complete.",
          ["pending", "in_progress", "submitted", "complete"],
        ),
      },
    },
    description:
      "Changes a requirement's status or due date. Status cannot change while a Checkr screening is active.",
    method: "PATCH",
    name: "update_employee_requirement",
    params: { id: requirementId },
    path: "/api/employee-forms/{id}",
    title: "Update employee requirement",
  },
  {
    description:
      "Deletes a requirement and its upload. Requirements with a started screening cannot be deleted.",
    destructive: true,
    method: "DELETE",
    name: "delete_employee_requirement",
    params: { id: requirementId },
    path: "/api/employee-forms/{id}",
    title: "Delete employee requirement",
  },
  {
    body: {
      properties: {
        city: text("Optional work city.", { maxLength: 100 }),
        state: text("Two-letter uppercase US work state, such as CA.", {
          pattern: "^[A-Z]{2}$",
        }),
      },
      required: ["state"],
    },
    description:
      "Starts a Checkr background or credit screening. Checkr emails the person to collect their information and consent.",
    method: "POST",
    name: "start_checkr_screening",
    openWorld: true,
    params: { id: requirementId },
    path: "/api/employee-forms/{id}/checkr/start",
    title: "Start Checkr screening",
  },
  {
    description:
      "Fetches the latest Checkr invitation and report status for a screening.",
    method: "POST",
    name: "refresh_checkr_screening",
    openWorld: true,
    params: { id: requirementId },
    path: "/api/employee-forms/{id}/checkr/refresh",
    title: "Refresh Checkr screening",
  },
];
