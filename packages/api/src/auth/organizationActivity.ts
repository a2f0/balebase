import { getCurrentAuthContext } from "@better-auth/core/context";
import type {
  DBAdapter,
  DBTransactionAdapter,
} from "@better-auth/core/db/adapter";
import { APIError, type BetterAuthPlugin } from "better-auth";
import {
  type MemberRemovalReason,
  removeMemberWithActivity,
} from "../organizations/memberRemoval";

type AuthRequest = Awaited<ReturnType<typeof getCurrentAuthContext>>;

const removalReasons: Record<string, MemberRemovalReason> = {
  "/organization/leave": "member_left",
  "/organization/remove-member": "member_removed",
};

const actorField = {
  fieldName: "activity_actor_id",
  input: false,
  required: false,
  returned: false,
  type: "string",
} as const;

/**
 * Records Better Auth's organization access changes with the request's actor.
 * Role changes, invitations, joining by invitation and organization renames
 * carry the actor in the same write, where the triggers of migrations 0057
 * and 0080 record the event. Removing a member and leaving run as one
 * recorded batch instead (memberRemoval.ts). Better Auth checks permissions
 * before each of these writes.
 */
export function organizationActivity(database: D1Database) {
  return {
    id: "organization-activity",
    schema: {
      invitation: { fields: { activityActorId: actorField } },
      member: {
        fields: {
          activityActorId: actorField,
          activityInvitationId: {
            fieldName: "activity_invitation_id",
            input: false,
            required: false,
            returned: false,
            type: "string",
          },
        },
      },
      organization: { fields: { activityActorId: actorField } },
    },
    init(context) {
      const adapter = context.adapter;
      const auditedAdapter: DBAdapter = {
        ...adapter,
        ...auditedWrites(adapter, database),
        // Better Auth runs some writes (member removal among them) inside a
        // transaction, on the adapter it passes to the callback.
        transaction: (callback) =>
          adapter.transaction((transaction) =>
            callback({
              ...transaction,
              ...auditedWrites(transaction, database),
            }),
          ),
      };
      return { context: { adapter: auditedAdapter } };
    },
  } satisfies BetterAuthPlugin;
}

function auditedWrites(
  adapter: DBTransactionAdapter,
  database: D1Database,
): Pick<DBTransactionAdapter, "create" | "delete" | "incrementOne" | "update"> {
  return {
    async create(input) {
      // Resolve the actor per call, including concurrent HTTP and auth.api
      // requests.
      const request = await authRequest();
      if (
        input.model === "invitation" &&
        atPath(request, "/organization/invite-member")
      ) {
        return adapter.create({
          ...input,
          data: { ...input.data, activityActorId: actorOf(request) },
        });
      }
      if (
        input.model === "member" &&
        atPath(request, "/organization/accept-invitation")
      ) {
        return adapter.create({
          ...input,
          data: {
            ...input.data,
            activityInvitationId: invitationIdOf(request),
          },
        });
      }
      return adapter.create(input);
    },
    async delete(input) {
      const request = await authRequest();
      const reason = request?.path ? removalReasons[request.path] : undefined;
      const memberId = input.where.find(({ field }) => field === "id")?.value;
      if (
        input.model !== "member" ||
        !request ||
        !reason ||
        typeof memberId !== "string"
      ) {
        return adapter.delete(input);
      }
      const result = await removeMemberWithActivity(database, {
        actorId: actorOf(request),
        memberId,
        reason,
      });
      if (result === "forbidden") {
        throw new APIError("FORBIDDEN", {
          message: "You are not allowed to remove this member.",
        });
      }
      if (result === "not_found") {
        throw new APIError("BAD_REQUEST", { message: "Member not found" });
      }
    },
    async incrementOne(input) {
      const request = await authRequest();
      if (
        input.model !== "invitation" ||
        !Object.hasOwn(input.set ?? {}, "status") ||
        !request
      ) {
        return adapter.incrementOne(input);
      }
      return adapter.incrementOne({
        ...input,
        set: { ...input.set, activityActorId: actorOf(request) },
      });
    },
    async update(input) {
      const request = await authRequest();
      const recorded =
        (input.model === "member" &&
          Object.hasOwn(input.update, "role") &&
          atPath(request, "/organization/update-member-role")) ||
        (input.model === "organization" &&
          atPath(request, "/organization/update"));
      if (!recorded || !request) return adapter.update(input);
      return adapter.update({
        ...input,
        update: { ...input.update, activityActorId: actorOf(request) },
      });
    },
  };
}

/** The request behind an adapter call, if Better Auth is serving one. */
async function authRequest(): Promise<AuthRequest | undefined> {
  try {
    return await getCurrentAuthContext();
  } catch {
    return undefined;
  }
}

function atPath(
  request: AuthRequest | undefined,
  path: string,
): request is AuthRequest {
  return request?.path === path;
}

function actorOf(request: AuthRequest) {
  const actorId = request.context.session?.user.id;
  if (!actorId) throw new APIError("UNAUTHORIZED");
  return actorId;
}

function invitationIdOf(request: AuthRequest) {
  const body: unknown = request.body;
  const invitationId =
    typeof body === "object" && body !== null
      ? Reflect.get(body, "invitationId")
      : undefined;
  if (typeof invitationId !== "string") throw new APIError("BAD_REQUEST");
  return invitationId;
}
