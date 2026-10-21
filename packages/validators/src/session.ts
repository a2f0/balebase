import { z } from "zod";
import { route } from "./route";

/** The signed-in person, as Better Auth stores them. */
const SessionUserSchema = z.looseObject({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});

export const sessionRoutes = {
  me: route({
    method: "GET",
    path: "/api/me",
    response: z.object({
      /** Set when an organization API key made the request. */
      apiKey: z
        .object({
          access: z.enum(["read", "write"]),
          channel: z.enum(["mcp", "rest"]),
          id: z.string(),
          organizationId: z.string(),
        })
        .optional(),
      user: SessionUserSchema,
    }),
  }),
  admin: route({
    method: "GET",
    path: "/api/admin",
    response: z.object({ user: SessionUserSchema }),
  }),
};
