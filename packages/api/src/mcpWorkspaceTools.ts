import type { JsonSchemaType } from "@modelcontextprotocol/server";
import {
  activityCursor,
  date,
  id,
  list,
  type McpTool,
  nullable,
  oneOf,
  text,
} from "./mcpToolSchema";

const equipmentTypes = ["computer", "cell_phone", "monitor"] as const;

const equipmentFields: Record<string, JsonSchemaType> = {
  assigneeId: nullable(
    text(
      "The user id (not member id) of an organization member to assign, or null to unassign. list_equipment returns the members.",
      { maxLength: 200 },
    ),
  ),
  make: text("Manufacturer, such as Apple.", { maxLength: 80, minLength: 1 }),
  model: text("Model name.", { maxLength: 120, minLength: 1 }),
  purchaseDate: nullable(date("Purchase date as YYYY-MM-DD, or null.")),
  serialNumber: nullable(
    text("Serial number, or null to clear.", { maxLength: 100 }),
  ),
  type: oneOf("Equipment type.", equipmentTypes),
};

const businessFields: Record<string, JsonSchemaType> = {
  city: nullable(text("City, or null to clear.", { maxLength: 100 })),
  duns: nullable(
    text("DUNS number: 9 digits, optionally formatted 12-345-6789.", {
      pattern: "^(?:\\d{9}|\\d{2}-\\d{3}-\\d{4})$",
    }),
  ),
  ein: nullable(
    text("Employer Identification Number: 9 digits, optionally 12-3456789.", {
      pattern: "^\\d{2}-?\\d{7}$",
    }),
  ),
  incorporationDate: nullable(date("Incorporation date as YYYY-MM-DD.")),
  name: text("Legal business name.", { maxLength: 120, minLength: 1 }),
  state: nullable(
    text("Two-letter US state code, such as CA.", {
      pattern: "^[A-Za-z]{2}$",
    }),
  ),
  streetAddress: nullable(text("Street address.", { maxLength: 240 })),
  zip: nullable(
    text("ZIP or ZIP+4 code.", { pattern: "^\\d{5}(?:-\\d{4})?$" }),
  ),
};

const groupFields: Record<string, JsonSchemaType> = {
  capabilities: list(
    'Capabilities members of this group receive. "finance" grants the Finance pages and tools.',
    oneOf("A capability.", ["finance"]),
  ),
  name: text("Group name, unique in the organization.", {
    maxLength: 100,
    minLength: 1,
  }),
  userIds: list(
    "User ids (not member ids) of the organization members in the group. This replaces the current members.",
    id("A member's user id."),
    { maxItems: 100 },
  ),
};

export const workspaceTools: McpTool[] = [
  {
    description:
      "Shows who this API key acts as: its creator's user record, plus the key's id, organization, and access level.",
    method: "GET",
    name: "get_current_identity",
    path: "/api/me",
    title: "Get current identity",
  },
  {
    description:
      "Lists the organization's activity feed, newest first, 50 events per page: audits, forms, issues, transaction annotations, equipment, role changes, and API keys. Finance activity requires Finance access. Pass nextCursor to page.",
    method: "GET",
    name: "list_activity",
    path: "/api/activity",
    query: { cursor: activityCursor },
    title: "List organization activity",
  },
  {
    description:
      "Lists organization members with their member ids, user ids, roles, and two-factor settings, plus pending invitations.",
    method: "GET",
    name: "list_people",
    path: "/api/organization-settings/people",
    title: "List people",
  },
  {
    description:
      "Shows the key creator's role in the organization and the capabilities, such as finance, that their groups grant.",
    method: "GET",
    name: "get_capabilities",
    path: "/api/organization-groups/access",
    title: "Get capabilities",
  },
  {
    description:
      "Lists organization groups with their capabilities and member user ids, and the members who can be added.",
    method: "GET",
    name: "list_groups",
    path: "/api/organization-groups",
    title: "List groups",
  },
  {
    body: { properties: groupFields, required: Object.keys(groupFields) },
    description: "Creates a group with a name, capabilities, and members.",
    method: "POST",
    name: "create_group",
    path: "/api/organization-groups",
    title: "Create group",
  },
  {
    body: { properties: groupFields, required: Object.keys(groupFields) },
    description:
      "Replaces a group's name, capabilities, and members. Send every field, including members who should stay.",
    method: "PATCH",
    name: "update_group",
    params: { id: id("Group id from list_groups.") },
    path: "/api/organization-groups/{id}",
    title: "Update group",
  },
  {
    description:
      "Deletes a group. Its members lose the capabilities it granted.",
    destructive: true,
    method: "DELETE",
    name: "delete_group",
    params: { id: id("Group id from list_groups.") },
    path: "/api/organization-groups/{id}",
    title: "Delete group",
  },
  {
    description:
      "Lists equipment (computers, cell phones, monitors) with assignees and linked email counts, plus the members equipment can be assigned to.",
    method: "GET",
    name: "list_equipment",
    path: "/api/equipment",
    title: "List equipment",
  },
  {
    description:
      "Gets one item of equipment and the inbox emails linked to it.",
    method: "GET",
    name: "get_equipment",
    params: { id: id("Equipment id from list_equipment.") },
    path: "/api/equipment/{id}",
    title: "Get equipment",
  },
  {
    description:
      "Lists the change history of one item of equipment, newest first.",
    method: "GET",
    name: "list_equipment_activity",
    params: { id: id("Equipment id from list_equipment.") },
    path: "/api/equipment/{id}/activity",
    query: { cursor: activityCursor },
    title: "List equipment activity",
  },
  {
    body: {
      properties: equipmentFields,
      required: ["type", "make", "model"],
    },
    description: "Adds an item of equipment, optionally assigned to a member.",
    method: "POST",
    name: "create_equipment",
    path: "/api/equipment",
    title: "Create equipment",
  },
  {
    body: { properties: equipmentFields },
    description:
      "Changes an item of equipment. Only the fields you send change; null or an empty string clears serialNumber, purchaseDate, or assigneeId.",
    method: "PATCH",
    name: "update_equipment",
    params: { id: id("Equipment id from list_equipment.") },
    path: "/api/equipment/{id}",
    title: "Update equipment",
  },
  {
    description: "Deletes an item of equipment and unlinks its emails.",
    destructive: true,
    method: "DELETE",
    name: "delete_equipment",
    params: { id: id("Equipment id from list_equipment.") },
    path: "/api/equipment/{id}",
    title: "Delete equipment",
  },
  {
    description:
      "Lists the organization's businesses with EIN, DUNS, incorporation date, and address.",
    method: "GET",
    name: "list_businesses",
    path: "/api/businesses",
    title: "List businesses",
  },
  {
    description: "Gets one business.",
    method: "GET",
    name: "get_business",
    params: { id: id("Business id from list_businesses.") },
    path: "/api/businesses/{id}",
    title: "Get business",
  },
  {
    body: { properties: businessFields, required: ["name"] },
    description:
      "Adds a business. EIN and DUNS numbers must be unique in the organization.",
    method: "POST",
    name: "create_business",
    path: "/api/businesses",
    title: "Create business",
  },
  {
    body: { properties: businessFields, required: ["name"] },
    description:
      "Changes a business. name is always required; omitted fields keep their values and null clears them.",
    method: "PATCH",
    name: "update_business",
    params: { id: id("Business id from list_businesses.") },
    path: "/api/businesses/{id}",
    title: "Update business",
  },
  {
    description: "Deletes a business.",
    destructive: true,
    method: "DELETE",
    name: "delete_business",
    params: { id: id("Business id from list_businesses.") },
    path: "/api/businesses/{id}",
    title: "Delete business",
  },
];
