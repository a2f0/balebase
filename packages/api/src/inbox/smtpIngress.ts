import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../auth/apiEnv";
import { readBodyWithLimit } from "../shared/storage";
import { InvalidInboundMime, ingestInboundEmail, maxEmailBytes } from "./email";
import { isPlatformDomain } from "./inboundEmailAddress";
import { hasPublicProof, txtChallenge } from "./routingDomains";

export const smtpIngress = new Hono<ApiEnv>();
smtpIngress.use("*", async (c, next) => {
  const key = c.env.SMTP_INGRESS_TOKEN;
  if (!key || key.length < 32) return c.body(null, 503);
  const expected = Buffer.from(`Bearer ${key}`);
  const received = Buffer.from(c.req.header("Authorization") ?? "");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return c.body(null, 401);
  return next();
});

async function recipient(db: D1Database, address: string, inbound: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (isPlatformDomain(domain, inbound)) return null;
  return db
    .prepare(
      `SELECT b.id, b.organization_id, d.domain, d.token FROM inbound_mailboxes b
     JOIN inbound_domains d ON d.organization_id=b.organization_id AND d.domain=? AND d.verified_at IS NOT NULL
     JOIN organization o ON o.id=b.organization_id AND o.deletedAt IS NULL
     WHERE b.address=? AND b.disconnected_at IS NULL`,
    )
    .bind(domain, address)
    .first<{
      id: string;
      organization_id: string;
      domain: string;
      token: string;
    }>();
}
function envelopeAddress(value: string | undefined) {
  const parsed = z.email().max(254).safeParse(value?.toLowerCase());
  return parsed.success ? parsed.data : null;
}

smtpIngress.post("/recipient", async (c) => {
  const address = envelopeAddress(c.req.header("X-Inbound-Recipient"));
  if (!address) return c.body(null, 404);
  const box = await recipient(c.env.DB, address, c.env.INBOUND_EMAIL_DOMAIN);
  if (!box) return c.body(null, 404);
  try {
    if (!(await hasPublicProof(txtChallenge(box.domain, box.token))))
      return c.body(null, 503);
  } catch {
    // Keep mail with the sending MTA while DNS is unavailable or proof is missing.
    return c.body(null, 503);
  }
  return c.json({ mailboxId: box.id, organizationId: box.organization_id });
});

smtpIngress.post("/deliver", async (c) => {
  const address = envelopeAddress(c.req.header("X-Inbound-Recipient"));
  const sender = c.req.header("X-Inbound-Sender") ?? "";
  const delivery = z.uuid().safeParse(c.req.header("X-Inbound-Delivery"));
  const mailbox = z.uuid().safeParse(c.req.header("X-Inbound-Mailbox"));
  const size = Number(c.req.header("Content-Length"));
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > maxEmailBytes ||
    !c.req.header("Content-Length") ||
    !c.req.raw.body ||
    !address ||
    sender.length > 254 ||
    !delivery.success ||
    !mailbox.success
  )
    return c.body(null, 400);

  const received = () =>
    c.env.DB.prepare(
      "SELECT 1 FROM inbound_smtp_receipts WHERE delivery_id=? AND mailbox_id=?",
    )
      .bind(delivery.data, mailbox.data)
      .first();
  if (await received()) return c.body(null, 204);
  const box = await recipient(c.env.DB, address, c.env.INBOUND_EMAIL_DOMAIN);
  if (box?.id !== mailbox.data) return c.body(null, 410);
  const raw = await readBodyWithLimit(c.req.raw.body, maxEmailBytes, 60_000);
  if (!raw) return c.body(null, 413);
  if (raw.byteLength !== size) return c.body(null, 400);
  let rejected = false;
  try {
    await ingestInboundEmail(
      {
        from: sender,
        to: address,
        raw,
        rawSize: size,
        setReject() {
          rejected = true;
        },
      },
      box.organization_id,
      box.id,
      c.env,
      delivery.data,
    );
  } catch (error) {
    if (error instanceof InvalidInboundMime) return c.body(null, 422);
    // Concurrent replay or a lost D1 response. Each attempt uses independent
    // object keys, and the receipt and original message commit together.
    if (!(await received())) throw error;
  }
  return c.body(null, rejected ? 410 : 204);
});
