import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { LinkedEmailSchema } from "./inbox";
import { route } from "./route";

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
  types: z.array(z.string()),
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
  assigneeId: z.string().nullable(),
  make: z.string(),
  model: z.string(),
  purchaseDate: z.string().nullable(),
  serialNumber: z.string().nullable(),
  type: z.string(),
});
export type EquipmentInput = z.infer<typeof EquipmentFieldsSchema>;

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
    body: EquipmentFieldsSchema.partial({
      assigneeId: true,
      purchaseDate: true,
      serialNumber: true,
    }),
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
    body: EquipmentFieldsSchema.partial(),
    response: EquipmentResponseSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/equipment/:id",
    response: "empty",
  }),
};
