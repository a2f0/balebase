import { z } from "zod";
import { route } from "./route";

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
  city: z.string().nullish(),
  duns: z.string().nullish(),
  ein: z.string().nullish(),
  incorporationDate: z.string().nullish(),
  name: z.string(),
  state: z.string().nullish(),
  streetAddress: z.string().nullish(),
  zip: z.string().nullish(),
});
export type BusinessInput = z.infer<typeof BusinessInputSchema>;

const BusinessListingSchema = z.object({
  businesses: z.array(BusinessSchema),
  canManage: z.boolean(),
});
export type BusinessListing = z.infer<typeof BusinessListingSchema>;

const BusinessDetailSchema = z.object({
  business: BusinessSchema,
  canManage: z.boolean(),
});
export type BusinessDetail = z.infer<typeof BusinessDetailSchema>;

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
