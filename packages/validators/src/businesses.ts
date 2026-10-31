import { z } from "zod";
import { ActivityPageSchema, ActivityQuerySchema } from "./activity";
import { calendarDate, optionalText, requiredText } from "./fields";
import { route } from "./route";
import { businessLimits } from "./rules";

const BusinessSchema = z.object({
  city: z.string().nullable(),
  createdAt: z.string(),
  /** Nine digits, without dashes. */
  duns: z.string().nullable(),
  /** Nine digits, without the dash. */
  ein: z.string().nullable(),
  id: z.string(),
  /** YYYY-MM-DD. */
  incorporationDate: z.string().nullable(),
  name: z.string(),
  /** A two-letter state code. */
  state: z.string().nullable(),
  streetAddress: z.string().nullable(),
  updatedAt: z.string(),
  zip: z.string().nullable(),
});
export type Business = z.infer<typeof BusinessSchema>;

/** A field left out keeps its value on update; null or blank clears it. */
const BusinessInputSchema = z.object({
  city: optionalText(z.string().trim().max(businessLimits.city)),
  /** Nine digits, bare or grouped as 12-345-6789; stored bare. */
  duns: optionalText(
    z
      .string()
      .trim()
      .regex(/^(?:\d{9}|\d{2}-\d{3}-\d{4})$/)
      .transform((value) => value.replaceAll("-", "")),
  ),
  /** Nine digits, optionally as 12-3456789; stored bare. */
  ein: optionalText(
    z
      .string()
      .trim()
      .regex(/^\d{2}-?\d{7}$/)
      .transform((value) => value.replace("-", "")),
  ),
  incorporationDate: optionalText(calendarDate()),
  name: requiredText(businessLimits.name),
  /** A two-letter state code, in either case; stored in capitals. */
  state: optionalText(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase()),
  ),
  streetAddress: optionalText(
    z.string().trim().max(businessLimits.streetAddress),
  ),
  zip: optionalText(
    z
      .string()
      .trim()
      .regex(/^\d{5}(?:-\d{4})?$/),
  ),
});
export type BusinessInput = z.input<typeof BusinessInputSchema>;

const BusinessListingSchema = z.object({
  businesses: z.array(BusinessSchema),
  canManage: z.boolean(),
});
export type BusinessListing = z.infer<typeof BusinessListingSchema>;

const BusinessDetailSchema = z.object({
  business: BusinessSchema,
  canManage: z.boolean(),
});

const BusinessResponseSchema = z.object({ business: BusinessSchema });

export const businessesRoutes = {
  list: route({
    method: "GET",
    path: "/api/businesses",
    response: BusinessListingSchema,
  }),
  get: route({
    method: "GET",
    path: "/api/businesses/:id",
    response: BusinessDetailSchema,
  }),
  activity: route({
    method: "GET",
    path: "/api/businesses/:id/activity",
    query: ActivityQuerySchema,
    response: ActivityPageSchema,
  }),
  create: route({
    method: "POST",
    path: "/api/businesses",
    body: BusinessInputSchema,
    response: BusinessResponseSchema,
  }),
  update: route({
    method: "PATCH",
    path: "/api/businesses/:id",
    body: BusinessInputSchema,
    response: BusinessResponseSchema,
  }),
  delete: route({
    method: "DELETE",
    path: "/api/businesses/:id",
    response: "empty",
  }),
};
