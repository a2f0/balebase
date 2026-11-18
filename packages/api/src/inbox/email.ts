import type { Attachment } from "postal-mime";
import PostalMime from "postal-mime";
import { normalizeFilename } from "../shared/filenames";
import type { Bindings } from "../types";
import { resolveRecipient } from "./inboundEmailAddress";

export class InvalidInboundMime extends Error {}

export const maxEmailBytes = 25 * 1024 * 1024;
const maxHeaderTextLength = 1_000;

interface StoredAttachment {
  content: Attachment["content"];
  contentId: string | null;
  contentType: string;
  disposition: string | null;
  filename: string;
  id: string;
  objectKey: string;
  size: number;
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Bindings,
) {
  if (message.rawSize > maxEmailBytes) {
    message.setReject("Messages must be 25 MB or smaller");
    return;
  }

  const recipient = await resolveRecipient(
    env.DB,
    message.to,
    env.INBOUND_EMAIL_DOMAIN,
    env.PLATFORM_MAILBOX_ORGANIZATION_ID,
  );
  if (!recipient) {
    message.setReject("Unknown recipient");
    return;
  }

  await ingestInboundEmail(
    message,
    recipient.organizationId,
    recipient.mailboxId,
    env,
  );
}

type InboundMessage = Pick<
  ForwardableEmailMessage,
  "from" | "to" | "rawSize" | "setReject"
> & {
  raw: ForwardableEmailMessage["raw"] | Uint8Array;
};

export async function ingestInboundEmail(
  message: InboundMessage,
  organizationId: string,
  mailboxId: string | null,
  env: Pick<Bindings, "DB" | "STORAGE">,
  deliveryId?: string,
) {
  const emailId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const { attachments, cleanupPrefix, objects, parsed, rawObjectKey } =
    await storeMessageObjects(message, env, organizationId, emailId);
  const statements = [
    env.DB.prepare(
      `INSERT INTO inbound_emails
         (id, organization_id, message_id, envelope_from, envelope_to, subject,
          raw_object_key, raw_size, received_at, mailbox_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM deleted_object_cleanup WHERE id GLOB ? AND cleanup_token IS NULL) = ?
           AND EXISTS (SELECT 1 FROM organization WHERE id = ? AND deletedAt IS NULL)
           AND (? IS NULL OR EXISTS (SELECT 1 FROM inbound_mailboxes
             WHERE id = ? AND organization_id = ? AND disconnected_at IS NULL))`,
    ).bind(
      emailId,
      organizationId,
      normalizeHeaderText(parsed.messageId),
      normalizeHeaderText(message.from) ?? "",
      normalizeHeaderText(message.to) ?? "",
      normalizeHeaderText(parsed.subject),
      rawObjectKey,
      message.rawSize,
      createdAt,
      mailboxId,
      `${cleanupPrefix}*`,
      objects.length,
      organizationId,
      mailboxId,
      mailboxId,
      organizationId,
    ),
    ...attachmentWrites(env.DB, attachments, emailId, createdAt),
  ];

  if (deliveryId && mailboxId) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO inbound_smtp_receipts (delivery_id, mailbox_id)
       SELECT ?, ? WHERE EXISTS (SELECT 1 FROM inbound_emails WHERE id = ?)`,
      ).bind(deliveryId, mailboxId, emailId),
    );
  }
  try {
    const [inserted] = await env.DB.batch(statements);
    if (inserted?.meta.changes) return;
  } catch (error) {
    // A committed batch may lose its response. Its triggers already claimed
    // the uploaded bytes, so leave all cleanup to their durable records.
    if (
      await env.DB.prepare("SELECT id FROM inbound_emails WHERE id = ?")
        .bind(emailId)
        .first()
    )
      return;
    throw error;
  }
  message.setReject("Unknown recipient");
  await Promise.allSettled(objects.map((obj) => env.STORAGE.delete(obj.key)));
}

// Keep bound metadata parameters below D1's per-value limit. Attachment
// content is already in R2 and never enters these JSON batches.
function attachmentWrites(
  db: D1Database,
  attachments: StoredAttachment[],
  emailId: string,
  createdAt: string,
) {
  const statements: D1PreparedStatement[] = [];
  let rows: string[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  const flush = () => {
    statements.push(
      db
        .prepare(`INSERT INTO inbound_email_attachments
      (id,email_id,object_key,filename,content_type,size,disposition,content_id,created_at)
      SELECT value->>'$.id', ?, value->>'$.objectKey', value->>'$.filename', value->>'$.contentType',
        value->>'$.size', value->>'$.disposition', value->>'$.contentId', ?
      FROM json_each(?) WHERE EXISTS (SELECT 1 FROM inbound_emails WHERE id=?)`)
        .bind(emailId, createdAt, `[${rows.join(",")}]`, emailId),
    );
    rows = [];
    bytes = 0;
  };
  for (const { content: _content, ...metadata } of attachments) {
    const row = JSON.stringify(metadata);
    const size = encoder.encode(row).length + 1;
    if (rows.length && bytes + size > 128 * 1024) flush();
    rows.push(row);
    bytes += size;
  }
  if (rows.length) flush();
  return statements;
}

async function storeMessageObjects(
  message: Pick<InboundMessage, "raw">,
  env: Pick<Bindings, "DB" | "STORAGE">,
  organizationId: string,
  emailId: string,
) {
  const objectPrefix = `organizations/${organizationId}/inbound-emails/${emailId}`;
  const rawObjectKey = `${objectPrefix}/message.eml`;
  const raw =
    message.raw instanceof Uint8Array
      ? message.raw
      : await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw, {
    maxHeadersSize: 128 * 1024,
    maxNestingDepth: 30,
    maxRfc822NestingDepth: 0,
  }).catch((cause: unknown) => {
    throw new InvalidInboundMime(
      cause instanceof Error ? cause.message : "Invalid MIME message",
      { cause },
    );
  });
  const attachments = parsed.attachments.map((attachment, index) =>
    toStoredAttachment(attachment, index, objectPrefix),
  );
  const objects = [
    {
      id: "raw",
      key: rawObjectKey,
      content: raw,
      contentType: "message/rfc822",
    },
    ...attachments.map((item) => ({
      id: item.id,
      key: item.objectKey,
      content: item.content,
      contentType: item.contentType,
    })),
  ];
  const cleanupPrefix = `inbound-upload:${emailId}:`;
  // Keep each JSON parameter below D1's single-value limit, even for mail
  // with thousands of small MIME parts. Register every object before writing R2.
  const chunkSize = 512;
  const queuedAt = new Date().toISOString();
  for (let offset = 0; offset < objects.length; offset += chunkSize) {
    const keys = objects
      .slice(offset, offset + chunkSize)
      .map(({ id, key }) => [id, key]);
    await env.DB.prepare(
      `INSERT INTO deleted_object_cleanup (id, organization_id, object_key, deleted_at)
       SELECT ? || json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), ?
       FROM json_each(?)`,
    )
      .bind(cleanupPrefix, organizationId, queuedAt, JSON.stringify(keys))
      .run();
  }
  await Promise.all(
    objects.map((obj) =>
      env.STORAGE.put(obj.key, obj.content, {
        httpMetadata: { contentType: obj.contentType },
        customMetadata: { emailId, organizationId },
      }),
    ),
  );
  return { attachments, cleanupPrefix, objects, parsed, rawObjectKey };
}

function toStoredAttachment(
  attachment: Attachment,
  index: number,
  objectPrefix: string,
): StoredAttachment {
  const id = crypto.randomUUID();
  return {
    content: attachment.content,
    contentId: normalizeHeaderText(attachment.contentId),
    contentType: attachment.mimeType || "application/octet-stream",
    disposition: attachment.disposition,
    filename: normalizeFilename(
      attachment.filename ?? "",
      `attachment-${index + 1}`,
    ),
    id,
    objectKey: `${objectPrefix}/attachments/${id}`,
    size: contentByteLength(attachment.content),
  };
}

function contentByteLength(content: Attachment["content"]) {
  return typeof content === "string"
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;
}

function normalizeHeaderText(value: string | undefined) {
  const normalized = value?.replaceAll("\0", "").trim();
  return normalized ? normalized.slice(0, maxHeaderTextLength) : null;
}
