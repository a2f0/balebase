import { activityRoutes } from "@balebase/validators/activity";
import { businessesRoutes } from "@balebase/validators/businesses";
import { equipmentRoutes } from "@balebase/validators/equipment";
import { organizationGroupsRoutes } from "@balebase/validators/organizationGroups";
import { organizationSettingsRoutes } from "@balebase/validators/organizationSettings";
import { sessionRoutes } from "@balebase/validators/session";
import { activityCursor, type McpTool } from "./mcpToolSchema";

const equipmentId = { id: "Equipment id from list_equipment." };

const equipmentFields = {
  assigneeId:
    "The user id (not member id) of an organization member to assign, or null to unassign. list_equipment returns the members.",
  make: "Manufacturer, such as Apple.",
  model: "Model name.",
  purchaseDate: "Purchase date as YYYY-MM-DD, or null.",
  serialNumber: "Serial number, or null to clear.",
};

const businessId = { id: "Business id from list_businesses." };

const businessFields = {
  city: "City, or null to clear.",
  duns: "DUNS number: 9 digits, optionally formatted 12-345-6789.",
  ein: "Employer Identification Number: 9 digits, optionally 12-3456789.",
  incorporationDate: "Incorporation date as YYYY-MM-DD.",
  name: "Legal business name.",
  state: "Two-letter US state code, such as CA.",
  streetAddress: "Street address.",
  zip: "ZIP or ZIP+4 code.",
};

const groupId = { id: "Group id from list_groups." };

const groupFields = {
  capabilities:
    'Capabilities members of this group receive. "finance" grants the Finance pages and tools.',
  name: "Group name, unique in the organization.",
  userIds:
    "User ids (not member ids) of the organization members in the group. This replaces the current members.",
};

export const workspaceTools: McpTool[] = [
  {
    description:
      "Shows who this API key acts as: its creator's user record, plus the key's id, organization, and access level.",
    name: "get_current_identity",
    route: sessionRoutes.me,
    title: "Get current identity",
  },
  {
    description:
      "Lists the organization's activity feed, newest first, 50 events per page: audits, forms, issues, equipment, projects, role and group changes, API keys, transactions, bank connections, expense categories, and billing. Optionally filter by root resource type. Finance activity requires Finance access; group and billing activity require an organization owner or admin. Pass nextCursor to page, retaining the same filter.",
    descriptions: {
      ...activityCursor,
      resourceType:
        "Root resource type. Audit and transaction histories include their attached issues; issue means standalone workspace issues.",
    },
    name: "list_activity",
    route: activityRoutes.list,
    title: "List organization activity",
  },
  {
    description:
      "Lists organization members with their member ids, user ids, roles, and two-factor settings, plus pending invitations.",
    name: "list_people",
    route: organizationSettingsRoutes.people,
    title: "List people",
  },
  {
    description:
      "Shows the key creator's role in the organization and the capabilities, such as finance, that their groups grant.",
    name: "get_capabilities",
    route: organizationGroupsRoutes.access,
    title: "Get capabilities",
  },
  {
    description:
      "Lists organization groups with their capabilities and member user ids, and the members who can be added.",
    name: "list_groups",
    route: organizationGroupsRoutes.list,
    title: "List groups",
  },
  {
    description: "Creates a group with a name, capabilities, and members.",
    descriptions: groupFields,
    name: "create_group",
    route: organizationGroupsRoutes.create,
    title: "Create group",
  },
  {
    description:
      "Replaces a group's name, capabilities, and members. Send every field, including members who should stay.",
    descriptions: { ...groupId, ...groupFields },
    name: "update_group",
    route: organizationGroupsRoutes.update,
    title: "Update group",
  },
  {
    description:
      "Deletes a group. Its members lose the capabilities it granted.",
    descriptions: groupId,
    destructive: true,
    name: "delete_group",
    route: organizationGroupsRoutes.delete,
    title: "Delete group",
  },
  {
    description:
      "Lists equipment (computers, cell phones, monitors) with assignees and linked email counts, plus the members equipment can be assigned to.",
    name: "list_equipment",
    route: equipmentRoutes.list,
    title: "List equipment",
  },
  {
    description:
      "Gets one item of equipment and the inbox emails linked to it.",
    descriptions: equipmentId,
    name: "get_equipment",
    route: equipmentRoutes.get,
    title: "Get equipment",
  },
  {
    description:
      "Lists the change history of one item of equipment, newest first.",
    descriptions: { ...equipmentId, ...activityCursor },
    name: "list_equipment_activity",
    route: equipmentRoutes.activity,
    title: "List equipment activity",
  },
  {
    description: "Adds an item of equipment, optionally assigned to a member.",
    descriptions: { ...equipmentFields, type: "Equipment type." },
    name: "create_equipment",
    route: equipmentRoutes.create,
    title: "Create equipment",
  },
  {
    description:
      "Changes an item of equipment. Only the fields you send change; null or an empty string clears serialNumber, purchaseDate, or assigneeId.",
    descriptions: {
      ...equipmentId,
      ...equipmentFields,
      type: "Equipment type: computer, cell_phone, or monitor. An item can keep a type that is no longer offered.",
    },
    name: "update_equipment",
    route: equipmentRoutes.update,
    title: "Update equipment",
  },
  {
    description: "Deletes an item of equipment and unlinks its emails.",
    descriptions: equipmentId,
    destructive: true,
    name: "delete_equipment",
    route: equipmentRoutes.delete,
    title: "Delete equipment",
  },
  {
    description:
      "Lists the organization's businesses with EIN, DUNS, incorporation date, and address.",
    name: "list_businesses",
    route: businessesRoutes.list,
    title: "List businesses",
  },
  {
    description: "Gets one business.",
    descriptions: businessId,
    name: "get_business",
    route: businessesRoutes.get,
    title: "Get business",
  },
  {
    description:
      "Adds a business. EIN and DUNS numbers must be unique in the organization.",
    descriptions: businessFields,
    name: "create_business",
    route: businessesRoutes.create,
    title: "Create business",
  },
  {
    description:
      "Changes a business. name is always required; omitted fields keep their values and null clears them.",
    descriptions: { ...businessId, ...businessFields },
    name: "update_business",
    route: businessesRoutes.update,
    title: "Update business",
  },
  {
    description: "Deletes a business.",
    descriptions: businessId,
    destructive: true,
    name: "delete_business",
    route: businessesRoutes.delete,
    title: "Delete business",
  },
];
