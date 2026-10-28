import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { CalendarDateSchema, optionalText, requiredText } from "./fields";
import { LinkedEmailSchema } from "./inbox";
import { route } from "./route";
import { equipmentLimits, equipmentTypes } from "./rules";

const EquipmentMemberSchema = z.object({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});
export type EquipmentMember = z.infer<typeof EquipmentMemberSchema>;

const EquipmentItemSchema = z.object({
  assignee: EquipmentMemberSchema.nullable(),
  createdAt: z.string(),
  /** Inbox emails outside Trash linked to this item. */
  emailCount: z.number(),
  id: z.string(),
  make: z.string(),
  model: z.string(),
  purchaseDate: z.string().nullable(),
  serialNumber: z.string().nullable(),
  /** Kept as stored, so an item keeps a type no longer offered. */
  type: z.string(),
  updatedAt: z.string(),
});
export type EquipmentItem = z.infer<typeof EquipmentItemSchema>;

const EquipmentContextSchema = z.object({
  canManage: z.boolean(),
  members: z.array(EquipmentMemberSchema),
  /** The types new equipment can have, in display order. */
  types: z.array(z.enum(equipmentTypes)),
});

const EquipmentListingSchema = EquipmentContextSchema.extend({
  equipment: z.array(EquipmentItemSchema),
});
export type EquipmentListing = z.infer<typeof EquipmentListingSchema>;

const EquipmentDetailSchema = EquipmentContextSchema.extend({
  emails: z.array(LinkedEmailSchema),
  equipment: EquipmentItemSchema,
});
export type EquipmentDetail = z.infer<typeof EquipmentDetailSchema>;

const EquipmentFieldsSchema = z.object({
  /** The user ID of an organization member; null unassigns. */
  assigneeId: optionalText(z.string().trim().max(200)),
  make: requiredText(equipmentLimits.make),
  model: requiredText(equipmentLimits.model),
  purchaseDate: optionalText(CalendarDateSchema),
  serialNumber: optionalText(
    z.string().trim().max(equipmentLimits.serialNumber),
  ),
  type: z.enum(equipmentTypes),
});
export type NewEquipment = z.input<typeof EquipmentFieldsSchema>;

// An item may keep a type no longer offered, so the API checks `type`
// against the stored item.
const EquipmentChangesSchema = EquipmentFieldsSchema.partial().extend({
  type: z.string().optional(),
});

/** A complete equipment form, as the app fills it in to add or edit. */
export type EquipmentInput = {
  [Field in keyof z.input<typeof EquipmentChangesSchema>]-?: Exclude<
    z.input<typeof EquipmentChangesSchema>[Field],
    undefined
  >;
};

const EquipmentResponseSchema = z.object({ equipment: EquipmentItemSchema });

export const equipmentRoutes = {
  list: route({
    method: "GET",
    path: "/api/equipment",
    response: EquipmentListingSchema,
  }),
  create: route({
    method: "POST",
    path: "/api/equipment",
    body: EquipmentFieldsSchema,
    response: EquipmentResponseSchema,
  }),
  get: route({
    method: "GET",
    path: "/api/equipment/:id",
    response: EquipmentDetailSchema,
  }),
  activity: route({
    method: "GET",
    path: "/api/equipment/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  /** Changes only the fields sent; `assigneeId: null` unassigns. */
  update: route({
    method: "PATCH",
    path: "/api/equipment/:id",
    body: EquipmentChangesSchema,
    response: EquipmentResponseSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/equipment/:id",
    response: "empty",
  }),
};
