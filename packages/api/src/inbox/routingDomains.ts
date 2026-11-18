import { resolveMx, resolveTxt } from "node:dns/promises";
import { type DomainClaim, inboxRoutes } from "@balebase/validators/inbox";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { stillManages } from "../organizations/organizationMembers";
import { activityStatement } from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import { isPlatformDomain } from "./inboundEmailAddress";

interface DomainRow {
  id: string;
  domain: string;
  token: string;
  verified_at: string | null;
}

export function txtChallenge(domain: string, token: string) {
  return {
    recordName: `_balebase-verification.${domain}`,
    recordValue: `balebase-verification=${token}`,
  };
}
export async function hasPublicProof(
  challenge: { recordName: string; recordValue: string },
  lookup = resolveTxt,
) {
  const records = await lookup(challenge.recordName);
  return records.some((parts) => parts.join("") === challenge.recordValue);
}

function domainClaim(row: DomainRow): DomainClaim {
  return {
    domain: row.domain,
    id: row.id,
    ...txtChallenge(row.domain, row.token),
    status: row.verified_at ? "verified" : "pending",
  };
}

export async function listDomains(db: D1Database, org: string) {
  const rows = await db
    .prepare(
      "SELECT * FROM inbound_domains WHERE organization_id = ? ORDER BY domain",
    )
    .bind(org)
    .all<DomainRow>();
  return rows.results.map(domainClaim);
}

export function routingActor(c: Context<ApiEnv>) {
  const org = c.get("organizationId");
  const userId = c.get("authSession").user.id;
  const manager = stillManages(org, userId);
  return {
    org,
    userId,
    manager: {
      sql: `${manager.sql} AND EXISTS (SELECT 1 FROM organization WHERE id = ? AND deletedAt IS NULL)`,
      bindings: [...manager.bindings, org],
    },
  };
}

export async function writeRouting(
  c: Context<ApiEnv>,
  statement: D1PreparedStatement,
  action: string,
  label: string,
) {
  const { org, userId } = routingActor(c);
  const [result] = await c.env.DB.batch([
    statement,
    activityStatement(
      c.env.DB,
      {
        action: `organization.${action}`,
        actorId: userId,
        details: { label },
        occurredAt: new Date().toISOString(),
        organizationId: org,
        root: { id: org, label, type: "organization" },
        subject: { id: org, type: "organization" },
      },
      { sql: "changes() = 1", bindings: [] },
    ),
  ]);
  return Boolean(result?.meta.changes);
}

export function directMx(env: {
  SMTP_MX_HOST?: string;
  SMTP_INGRESS_TOKEN?: string;
}) {
  return env.SMTP_MX_HOST && (env.SMTP_INGRESS_TOKEN?.length ?? 0) >= 32
    ? { host: env.SMTP_MX_HOST, priority: 10 }
    : null;
}

export function domainRoutes(
  lookup: (name: string) => Promise<string[][]> = resolveTxt,
  lookupMx = resolveMx,
) {
  const domains = new Hono<ApiEnv>();
  domains.post("/", claimDomain);
  domains.post("/:id/verify", (c) => verifyDomain(c, lookup));
  domains.get("/:id/mx", async (c) => {
    const mx = directMx(c.env);
    if (!mx)
      return c.json(
        { error: "Direct MX is unavailable in this environment." },
        503,
      );
    const row = await c.env.DB.prepare(
      "SELECT domain FROM inbound_domains WHERE id=? AND organization_id=? AND verified_at IS NOT NULL",
    )
      .bind(c.req.param("id"), c.get("organizationId"))
      .first<{ domain: string }>();
    if (!row) return c.json({ error: "Verified domain not found." }, 404);
    try {
      const records = await lookupMx(row.domain);
      const first = records[0];
      return respond(c, inboxRoutes.mx, {
        ready:
          records.length === 1 &&
          first?.exchange.toLowerCase().replace(/\.$/, "") === mx.host &&
          first.priority === mx.priority,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOTFOUND", "ENODATA"].includes(String(error.code))
      )
        return respond(c, inboxRoutes.mx, { ready: false });
      return c.json({ error: "DNS lookup failed. Try again shortly." }, 503);
    }
  });
  domains.delete("/:id", releaseDomain);
  return domains;
}

async function claimDomain(c: Context<ApiEnv>) {
  const body = await readBody(c, inboxRoutes.claim, "Enter a valid domain.");
  if (body instanceof Response) return body;
  if (isPlatformDomain(body.domain, c.env.INBOUND_EMAIL_DOMAIN))
    return c.json({ error: "Balebase manages this domain." }, 403);
  const { org, manager } = routingActor(c);
  await writeRouting(
    c,
    c.env.DB.prepare(
      `INSERT INTO inbound_domains (id, organization_id, domain, token)
       SELECT ?, ?, ?, ? WHERE ${manager.sql} ON CONFLICT (organization_id, domain) DO NOTHING`,
    ).bind(
      crypto.randomUUID(),
      org,
      body.domain,
      crypto.randomUUID(),
      ...manager.bindings,
    ),
    "inbound_domain_requested",
    body.domain,
  );
  const row = await c.env.DB.prepare(
    "SELECT * FROM inbound_domains WHERE organization_id = ? AND domain = ?",
  )
    .bind(org, body.domain)
    .first<DomainRow>();
  if (!row)
    return c.json({ error: "Organization manager access required." }, 403);
  return respond(c, inboxRoutes.claim, domainClaim(row));
}

async function verifyDomain(
  c: Context<ApiEnv, "/:id">,
  lookup: (name: string) => Promise<string[][]>,
) {
  const { org, manager } = routingActor(c);
  const row = await c.env.DB.prepare(
    "SELECT * FROM inbound_domains WHERE organization_id = ? AND id = ?",
  )
    .bind(org, c.req.param("id"))
    .first<DomainRow>();
  if (!row) return c.json({ error: "Domain request not found." }, 404);
  const claim = domainClaim(row);
  if (claim.status === "verified") return respond(c, inboxRoutes.verify, claim);
  let matches: boolean;
  try {
    matches = await hasPublicProof(claim, lookup);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENODATA", "ENOTFOUND"].includes(String(error.code))
    )
      matches = false;
    else return c.json({ error: "DNS lookup failed. Try again shortly." }, 503);
  }
  if (!matches)
    return c.json(
      {
        error:
          "The TXT record does not match yet. Check its name and value, then retry.",
      },
      409,
    );
  await writeRouting(
    c,
    c.env.DB.prepare(
      `UPDATE OR IGNORE inbound_domains SET verified_at = ? WHERE organization_id = ? AND id = ?
       AND token = ? AND verified_at IS NULL AND ${manager.sql}`,
    ).bind(
      new Date().toISOString(),
      org,
      row.id,
      row.token,
      ...manager.bindings,
    ),
    "inbound_domain_verified",
    row.domain,
  );
  const verified = await c.env.DB.prepare(
    "SELECT * FROM inbound_domains WHERE organization_id = ? AND id = ? AND verified_at IS NOT NULL",
  )
    .bind(org, row.id)
    .first<DomainRow>();
  if (!verified)
    return c.json(
      { error: "This domain could not be claimed by this organization." },
      409,
    );
  return respond(c, inboxRoutes.verify, domainClaim(verified));
}

async function releaseDomain(c: Context<ApiEnv, "/:id">) {
  const { org, manager } = routingActor(c);
  const row = await c.env.DB.prepare(
    "SELECT domain FROM inbound_domains WHERE id = ? AND organization_id = ?",
  )
    .bind(c.req.param("id"), org)
    .first<{ domain: string }>();
  if (!row) return c.json({ error: "Domain request not found." }, 404);
  const changed = await writeRouting(
    c,
    c.env.DB.prepare(
      `DELETE FROM inbound_domains WHERE id = ? AND organization_id = ? AND ${manager.sql}
       AND NOT EXISTS (SELECT 1 FROM inbound_mailboxes box WHERE box.organization_id = inbound_domains.organization_id
       AND substr(box.address, instr(box.address, '@')+1) = inbound_domains.domain AND box.disconnected_at IS NULL)`,
    ).bind(c.req.param("id"), org, ...manager.bindings),
    "inbound_domain_released",
    row.domain,
  );
  return changed
    ? c.body(null, 204)
    : c.json(
        {
          error:
            "Disconnect this domain's inboxes before releasing the domain.",
        },
        409,
      );
}
