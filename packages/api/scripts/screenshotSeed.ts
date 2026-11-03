import type { Database } from "bun:sqlite";
import { seedMember, seedUser } from "../src/testing/seed";
import { continuity, person } from "./continuity";
import {
  recordSteps,
  type Sender,
  type Step,
  type StepContext,
} from "./screenshotRecords";
import type { SentMessage } from "./screenshotServices";

/**
 * The organization screenshot capture shows: Harborline Electric from the
 * pinned continuity genesis (scripts/continuity.ts). Records go through the
 * API's own routes, each sent by the person canon says did it on the day it
 * says, so they carry the activity a real workspace would. Only the
 * teammates' accounts, who join without an invitation email, are written
 * directly.
 */

type Request = (path: string, init?: RequestInit) => Promise<Response>;

export interface SeedHost {
  database: Database;
  request: Request;
  /** Moves the seeding clock to the start of a canon day (`YYYY-MM-DD`). */
  setDay: (day: string) => void;
  /** Email the API sent, oldest first. */
  outbox: SentMessage[];
}

const { SCREENSHOT_EMAIL, SCREENSHOT_PASSWORD } = process.env;
// The capture's config passes the owner's placeholder credentials; teammates
// sign in with the same placeholder.
const password = SCREENSHOT_PASSWORD ?? "screenshot capture password";
const owner = person(continuity.organization.owner);

if (SCREENSHOT_EMAIL !== undefined && SCREENSHOT_EMAIL !== owner.email)
  throw new Error(
    `The capture signs in as ${SCREENSHOT_EMAIL}, but the continuity owner is ${owner.email}.`,
  );

/** Seeds the capture's organization, failing on any refused request. */
export async function seedScreenshotData(host: SeedHost) {
  let day = "";
  const sessions = new Map<string, { day: string; send: Sender }>();
  const context: StepContext = {
    // Sessions expire on the seeding clock too, so each person signs in again
    // on every day they act.
    as: async (id) => {
      const current = sessions.get(id);
      if (current?.day === day) return current.send;
      const send = sender(host.request);
      // Better Auth rate-limits sign-ins, and the seed signs in many times.
      host.database.query("DELETE FROM rateLimit").run();
      await send("POST", "/api/auth/sign-in/email", {
        email: person(id).email,
        password,
      });
      sessions.set(id, { day, send });
      return send;
    },
    anonymous: sender(host.request),
    ids: new Map(),
    // Teammates are keyed on their canon ID; the owner signed up for theirs.
    userId: (id) => {
      const row = host.database
        .query("SELECT id FROM user WHERE email = ?")
        .get(person(id).email) as { id: string } | null;
      if (!row) throw new Error(`${id} has no Balebase account.`);
      return row.id;
    },
    outbox: host.outbox,
  };
  const steps: Step[] = [
    { day: owner.joinedOn ?? continuity.asOf, run: () => found(host) },
    ...recordSteps(),
  ];
  // Canon order: the sort is stable, so steps on one day keep their order.
  steps.sort((a, b) => a.day.localeCompare(b.day));
  for (const step of steps) {
    day = step.day;
    host.setDay(day);
    await step.run(context);
  }
}

/** Signs the owner up and adds the teammates who hold a seat. */
async function found({ database, request }: SeedHost) {
  await sender(request)("POST", "/api/auth/sign-up/email", {
    email: owner.email,
    name: owner.name,
    password,
    termsAccepted: true,
  });
  const { organizationId, userId } = database
    .query(
      `SELECT user.id AS userId, member.organizationId
       FROM user JOIN member ON member.userId = user.id
       WHERE user.email = ?`,
    )
    .get(owner.email) as { organizationId: string; userId: string };
  database.query("UPDATE user SET emailVerified = 1 WHERE id = ?").run(userId);
  database
    .query("UPDATE organization SET name = ? WHERE id = ?")
    .run(continuity.organization.name, organizationId);
  const teammates = continuity.people.filter(
    (teammate) => teammate.role && teammate.id !== owner.id,
  );
  for (const teammate of teammates)
    addTeammate(database, teammate, userId, organizationId);
  // A seat for everyone: Stripe's side of a Pro subscription, which only a
  // Stripe webhook could otherwise write.
  database
    .query(
      `INSERT INTO organization_billing
       (organization_id, stripe_customer_id, stripe_subscription_id,
        stripe_price_id, stripe_status, seat_quantity, updated_at)
       VALUES (?, 'cus_screenshot', 'sub_screenshot', ?, 'active', ?, ?)`,
    )
    .run(
      organizationId,
      screenshotProPrice,
      teammates.length + 1,
      new Date().toISOString(),
    );
}

/** The Pro price the screenshot API's billing bindings name. */
export const screenshotProPrice = "price_screenshot_pro";

/**
 * A member keyed on their canon person ID: user and membership rows, and a
 * copy of the owner's credential account, so they sign in with the same
 * placeholder password.
 */
function addTeammate(
  database: Database,
  teammate: (typeof continuity.people)[number],
  ownerId: string,
  organizationId: string,
) {
  const joined = `${teammate.joinedOn ?? continuity.asOf}T16:00:00.000Z`;
  seedUser(database, {
    createdAt: joined,
    defaultOrganizationId: organizationId,
    email: teammate.email,
    id: teammate.id,
    name: teammate.name,
  });
  seedMember(database, {
    createdAt: joined,
    organizationId,
    role: teammate.role ?? "member",
    userId: teammate.id,
  });
  const account = database
    .query("SELECT * FROM account WHERE userId = ?")
    .get(ownerId) as Record<string, string | number | null>;
  const row = {
    ...account,
    accountId: teammate.id,
    createdAt: joined,
    id: `account_${teammate.id}`,
    updatedAt: joined,
    userId: teammate.id,
  };
  const columns = Object.keys(row);
  database
    .query(
      `INSERT INTO account (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
}

/** Sends JSON, a form, or a file, with the session its sign-in set. */
function sender(request: Request): Sender {
  let cookie = "";
  return async <T = unknown>(method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof Blob) {
      payload = body;
      headers["content-type"] = body.type;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const response = await request(path, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length)
      cookie = setCookie.map((value) => value.split(";", 1)[0]).join("; ");
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}
