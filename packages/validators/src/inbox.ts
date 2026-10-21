import { z } from "zod";

/** An email linked to a folder, transaction, or item, as the target lists it. */
export const LinkedEmailSchema = z.object({
  attachmentCount: z.number(),
  from: z.string(),
  id: z.string(),
  linkId: z.string(),
  receivedAt: z.string(),
  status: z.enum(["inbox", "archived"]),
  subject: z.string().nullable(),
});
export type LinkedEmail = z.infer<typeof LinkedEmailSchema>;

export const inboxRoutes = {};
