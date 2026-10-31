import { onTestFinished } from "bun:test";
import { adminJobs } from "../admin/adminJobs";
import { adminUsers } from "../admin/adminUsers";
import { requireRole } from "../auth/authMiddleware";
import { withNativeOrigin } from "../auth/nativeRequest";
import { consumeJobs } from "../jobs/jobWorker";
import { enqueueMaintenance, type MaintenanceJobId } from "../jobs/maintenance";
import { userDeletion } from "../users/userDeletion";
import { testBindings } from "./bindings";
import { queryHooks, toD1 } from "./d1";
import { createTestDatabase } from "./database";
import { seedUser } from "./seed";
import { testApp } from "./session";

export const now = new Date("2026-09-28T12:00:00.000Z");
export const origin = "https://app.example.com";

export function fixture(role = "admin", impersonatedBy?: string) {
  const database = createTestDatabase();
  onTestFinished(() => database.close());
  const messages: string[] = [];
  const deletedKeys: string[] = [];
  const hooks = queryHooks();
  const bindings = testBindings({
    CORS_ORIGIN: origin,
    DB: toD1(database, hooks),
    FINANCE_SYNC_QUEUE: {
      async send(body: { jobId: string }) {
        messages.push(body.jobId);
      },
    } as unknown as Queue<{ jobId: string }>,
    STORAGE: {
      async delete(key: string) {
        deletedKeys.push(key);
      },
    } as unknown as R2Bucket,
  });
  const app = maintenanceRoutes(role, impersonatedBy);
  function insertUser(id: string, requestedAt?: string, userRole = "user") {
    seedUser(database, { createdAt: now.toISOString(), id, role: userRole });
    if (requestedAt)
      database
        .query(
          "INSERT INTO user_deletion_requests (user_id, requested_at) VALUES (?, ?)",
        )
        .run(id, requestedAt);
  }
  return {
    database,
    bindings,
    /** Stores the session's actor, as production has it, with the session's role. */
    insertActor: () =>
      seedUser(database, {
        createdAt: now.toISOString(),
        email: "actor@example.com",
        id: "actor",
        name: "Admin Actor",
        role,
      }),
    /** Requests a run as the session's actor, who must be a stored admin. */
    async requestRun(jobId: MaintenanceJobId) {
      const run = await enqueueMaintenance(bindings, jobId, {
        trigger: "manual",
        actorUserId: "actor",
      });
      if (!run) throw new Error("The actor is not a stored admin.");
      return run;
    },
    messages,
    deletedKeys,
    deliver: (jobId: string) =>
      consumeJobs(
        {
          messages: [
            {
              body: { jobId },
              ack() {},
              retry() {
                throw new Error("Unexpected retry");
              },
            },
          ],
        } as unknown as MessageBatch<{ jobId: string }>,
        bindings,
      ),
    insertUser,
    beforeUserDelete: (callback: () => void) =>
      hooks.before(/^DELETE FROM user WHERE/, callback, { method: "first" }),
    beforeOrganizationPurge: (callback: () => void) =>
      hooks.before(/^DELETE FROM organization/, callback, { method: "first" }),
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, bindings, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext),
  };
}

/** The admin job, admin user, and account deletion routes as `role`. */
function maintenanceRoutes(role: string, impersonatedBy?: string) {
  const app = testApp(
    {},
    {
      email: "actor@example.com",
      name: "Admin Actor",
      role,
      session: { impersonatedBy },
      userId: "actor",
    },
  );
  app.use("*", async (context, next) => {
    context.req.raw = withNativeOrigin(
      context.req.raw,
      context.env.CORS_ORIGIN,
    );
    await next();
  });
  app.use("/jobs/*", requireRole("admin"));
  app.use("/users/*", requireRole("admin"));
  app.route("/jobs", adminJobs);
  app.route("/deletion", userDeletion);
  app.route("/users", adminUsers);
  return app;
}

export function post(confirm: string, requestOrigin = origin) {
  return {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm }),
  };
}
