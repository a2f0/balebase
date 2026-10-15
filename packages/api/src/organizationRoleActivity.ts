import { getCurrentAuthContext } from "@better-auth/core/context";
import { APIError, type BetterAuthPlugin } from "better-auth";

/** Attach the request's actor to Better Auth's authorized role UPDATE. */
export function organizationRoleActivity() {
  return {
    id: "organization-role-activity",
    schema: {
      member: {
        fields: {
          activityActorId: {
            fieldName: "activity_actor_id",
            input: false,
            required: false,
            returned: false,
            type: "string",
          },
        },
      },
    },
    init(context) {
      const adapter = context.adapter;
      const auditedAdapter: typeof adapter = {
        ...adapter,
        async update(input) {
          if (
            input.model !== "member" ||
            !Object.hasOwn(input.update, "role")
          ) {
            return adapter.update(input);
          }
          // Resolve the actor per call, including concurrent HTTP and auth.api
          // requests. Better Auth checks permissions before this UPDATE.
          const request = await getCurrentAuthContext();
          if (request.path !== "/organization/update-member-role") {
            return adapter.update(input);
          }
          const actorId = request.context.session?.user.id;
          if (!actorId) throw new APIError("UNAUTHORIZED");
          return adapter.update({
            ...input,
            update: { ...input.update, activityActorId: actorId },
          });
        },
      };
      return { context: { adapter: auditedAdapter } };
    },
  } satisfies BetterAuthPlugin;
}
