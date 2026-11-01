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
 * Creating an organization, role changes, invitations, joining by invitation
 * and organization renames carry the actor in the same write, where the
 * triggers of migrations 0057, 0083 and 0085 record the event. Removing a
 * member and leaving run as one recorded batch instead (memberRemoval.ts).
 * Better Auth checks permissions before each of these writes. Regenerating
 * two-factor backup codes is marked the same way, so its trigger can tell it
 * from a backup code being used (migration 0085).
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
      organization: {
        fields: {
          activityActorId: actorField,
          activityCreatedVia: {
            fieldName: "activity_created_via",
            input: false,
            required: false,
            returned: false,
            type: "string",
          },
        },
      },
      twoFactor: {
        fields: {
          activityChange: {
            fieldName: "activity_change",
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
      const stamp = createStamp(input.model, await authRequest());
      return adapter.create(
        stamp ? { ...input, data: { ...input.data, ...stamp } } : input,
      );
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
      const stamp = updateStamp(input, await authRequest());
      return adapter.update(
        stamp ? { ...input, update: { ...input.update, ...stamp } } : input,
      );
    },
  };
}

/** What a created row records about the request that created it. */
function createStamp(model: string, request: AuthRequest | undefined) {
  if (model === "organization" && atPath(request, "/organization/create")) {
    return { activityActorId: actorOf(request), activityCreatedVia: "create" };
  }
  if (
    model === "invitation" &&
    atPath(request, "/organization/invite-member")
  ) {
    return { activityActorId: actorOf(request) };
  }
  if (
    model === "member" &&
    atPath(request, "/organization/accept-invitation")
  ) {
    return { activityInvitationId: invitationIdOf(request) };
  }
  return undefined;
}

/** What an update records about the request that made it. */
function updateStamp(
  input: { model: string; update: object },
  request: AuthRequest | undefined,
) {
  if (
    input.model === "twoFactor" &&
    Object.hasOwn(input.update, "backupCodes") &&
    atPath(request, "/two-factor/generate-backup-codes")
  ) {
    return { activityChange: "backup_codes_regenerated" };
  }
  const recorded =
    (input.model === "member" &&
      Object.hasOwn(input.update, "role") &&
      atPath(request, "/organization/update-member-role")) ||
    (input.model === "organization" && atPath(request, "/organization/update"));
  return recorded && request
    ? { activityActorId: actorOf(request) }
    : undefined;
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
