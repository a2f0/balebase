import { inboxRoutes, type Mailbox } from "@balebase/validators/inbox";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { requireManager } from "../organizations/organizationMembers";
import { readBody, respond } from "../shared/respond";
import { forwardingAddress, isPlatformDomain } from "./inboundEmailAddress";
import {
  domainRoutes,
  listDomains,
  routingActor,
  writeRouting,
} from "./routingDomains";

interface MailboxRow {
  id: string;
  name: string;
  address: string;
  disconnected_at: string | null;
}

function describeMailbox(row: MailboxRow): Mailbox {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    connected: row.disconnected_at === null,
  };
}

export async function listMailboxes(db: D1Database, org: string) {
  const boxes = await db
    .prepare(
      "SELECT id, name, address, disconnected_at FROM inbound_mailboxes WHERE organization_id = ? ORDER BY name, address, id",
    )
    .bind(org)
    .all<MailboxRow>();
  return boxes.results.map(describeMailbox);
}

export function inboxRouting(lookup?: (name: string) => Promise<string[][]>) {
  const routing = new Hono<ApiEnv>();
  routing.use("*", requireManager(), async (c, next) =>
    c.get("apiKey")
      ? c.json({ error: "Sign in to manage inbox routing." }, 403)
      : next(),
  );
  routing.route("/domains", domainRoutes(lookup));
  routing.get("/", async (c) => {
    const org = c.get("organizationId");
    const [domains, boxes] = await Promise.all([
      listDomains(c.env.DB, org),
      c.env.DB.prepare(
        "SELECT * FROM inbound_mailboxes WHERE organization_id = ? AND disconnected_at IS NULL ORDER BY name, address",
      )
        .bind(org)
        .all<MailboxRow & { forwarding_id: string }>(),
    ]);
    return respond(c, inboxRoutes.routing, {
      domains,
      mailboxes: boxes.results.map((row) => ({
        ...describeMailbox(row),
        forwardingAddress: forwardingAddress(
          row.forwarding_id,
          c.env.INBOUND_EMAIL_DOMAIN,
        ),
      })),
    });
  });
  routing.post("/mailboxes", bindMailbox);
  routing.delete("/mailboxes/:id", disconnectMailbox);
  return routing;
}

async function bindMailbox(c: Context<ApiEnv>) {
  const body = await readBody(
    c,
    inboxRoutes.bind,
    "Enter an inbox name and a valid email address.",
  );
  if (body instanceof Response) return body;
  const domain = body.address.slice(body.address.lastIndexOf("@") + 1);
  const { org, userId, manager } = routingActor(c);
  if (
    domain === c.env.INBOUND_EMAIL_DOMAIN &&
    /^(?:upload|inbox)(?:\+|@)/.test(body.address)
  )
    return c.json(
      { error: "This address is reserved for inbound delivery." },
      403,
    );
  const platform = isPlatformDomain(domain, c.env.INBOUND_EMAIL_DOMAIN);
  if (platform && !c.get("authSession").user.role.split(",").includes("admin"))
    return c.json(
      { error: "Only a root administrator can bind a Balebase address." },
      403,
    );
  const allowed = platform
    ? "EXISTS (SELECT 1 FROM user WHERE id = ? AND instr(',' || role || ',', ',admin,') > 0)"
    : "EXISTS (SELECT 1 FROM inbound_domains WHERE organization_id = ? AND domain = ? AND verified_at IS NOT NULL)";
  const id = crypto.randomUUID();
  const forwardingId = crypto.randomUUID();
  const changed = await writeRouting(
    c,
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO inbound_mailboxes (id, organization_id, name, address, forwarding_id)
       SELECT ?, ?, ?, ?, ? WHERE ${manager.sql} AND ${allowed}`,
    ).bind(
      id,
      org,
      body.name,
      body.address,
      forwardingId,
      ...manager.bindings,
      ...(platform ? [userId] : [org, domain]),
    ),
    "inbound_address_bound",
    body.address,
  );
  if (!changed)
    return c.json(
      { error: "This address must be available on a verified domain." },
      409,
    );
  return respond(
    c,
    inboxRoutes.bind,
    {
      id,
      forwardingAddress: forwardingAddress(
        forwardingId,
        c.env.INBOUND_EMAIL_DOMAIN,
      ),
    },
    201,
  );
}

async function disconnectMailbox(c: Context<ApiEnv, "/:id">) {
  const { org, manager, userId } = routingActor(c);
  const mailbox = await c.env.DB.prepare(
    "SELECT address FROM inbound_mailboxes WHERE organization_id = ? AND id = ? AND disconnected_at IS NULL",
  )
    .bind(org, c.req.param("id"))
    .first<{ address: string }>();
  if (!mailbox) return c.json({ error: "Connected inbox not found." }, 404);
  const platform = isPlatformDomain(
    mailbox.address.slice(mailbox.address.indexOf("@") + 1),
    c.env.INBOUND_EMAIL_DOMAIN,
  );
  const changed = await writeRouting(
    c,
    c.env.DB.prepare(
      `UPDATE inbound_mailboxes SET disconnected_at = ? WHERE id = ? AND organization_id = ?
       AND disconnected_at IS NULL AND ${manager.sql}
       AND (? = 0 OR EXISTS (SELECT 1 FROM user WHERE id = ? AND instr(',' || role || ',', ',admin,') > 0))`,
    ).bind(
      new Date().toISOString(),
      c.req.param("id"),
      org,
      ...manager.bindings,
      Number(platform),
      userId,
    ),
    "inbound_address_disconnected",
    mailbox.address,
  );
  return changed
    ? c.body(null, 204)
    : c.json(
        { error: "Insufficient permissions or inbox already disconnected." },
        403,
      );
}
