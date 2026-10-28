import {
  type ContractMail,
  contractUrl,
  sendCompletion,
  sendSigningRequest,
  signingUrl,
} from "./contractMail";
import {
  type Certificate,
  type StampedField,
  sha256Hex,
  stampContract,
} from "./contractPdf";
import {
  type ContractRow,
  type EventRow,
  type FieldRow,
  findContractById,
  listEvents,
  listFields,
  listRecipients,
  mailFor,
  type RecipientRow,
  recordEvent,
} from "./contractRecords";
import {
  newTokenNonce,
  signingToken,
  signingTokenHash,
} from "./contractTokens";
import { trackedPut, uploadStillQueued } from "./storage";
import type { Bindings } from "./types";

export type ContractEnvironment = Pick<
  Bindings,
  | "AUTH_EMAIL_FROM"
  | "BETTER_AUTH_SECRET"
  | "CORS_ORIGIN"
  | "DB"
  | "EMAIL"
  | "STORAGE"
>;

/**
 * The signing link for a recipient who has been sent one. Links derive from
 * BETTER_AUTH_SECRET, so after it rotates the stored hash is refreshed and
 * the re-sent link opens while the old one no longer does.
 */
async function recipientLink(
  environment: ContractEnvironment,
  recipient: Pick<RecipientRow, "id" | "token_hash" | "token_nonce">,
) {
  if (!recipient.token_nonce) return null;
  const token = await signingToken(
    environment.BETTER_AUTH_SECRET,
    recipient.id,
    recipient.token_nonce,
  );
  const hash = await signingTokenHash(token);
  if (hash !== recipient.token_hash) {
    await environment.DB.prepare(
      `UPDATE contract_recipients SET token_hash = ?
       WHERE id = ? AND token_nonce = ?`,
    )
      .bind(hash, recipient.id, recipient.token_nonce)
      .run();
  }
  return signingUrl(environment, token);
}

/**
 * Emails each recipient their signing link, issuing it on first notice, and
 * records delivery. Returns how many emails were accepted for delivery.
 */
export async function notifyRecipients(
  environment: ContractEnvironment,
  contract: ContractRow,
  recipients: RecipientRow[],
  reminder: boolean,
  at = new Date(),
) {
  const database = environment.DB;
  const mail = await mailFor(database, contract);
  const now = at.toISOString();
  let delivered = 0;
  for (const recipient of recipients) {
    let link: string | null;
    if (!recipient.token_nonce) {
      const nonce = newTokenNonce();
      const token = await signingToken(
        environment.BETTER_AUTH_SECRET,
        recipient.id,
        nonce,
      );
      const issued = await database
        .prepare(
          `UPDATE contract_recipients
           SET status = 'sent', token_nonce = ?, token_hash = ?,
               notified_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(nonce, await signingTokenHash(token), now, recipient.id)
        .run();
      if (issued.meta.changes !== 1) continue;
      link = signingUrl(environment, token);
    } else {
      if (reminder) {
        await database
          .prepare(
            `UPDATE contract_recipients SET last_reminded_at = ? WHERE id = ?`,
          )
          .bind(now, recipient.id)
          .run();
      }
      link = await recipientLink(environment, recipient);
    }
    if (!link) continue;
    try {
      await sendSigningRequest(environment, mail, recipient, link, reminder);
      delivered += 1;
      await recordEvent(database, {
        contractId: contract.id,
        recipientId: recipient.id,
        type: reminder ? "reminded" : "notified",
      });
    } catch (cause) {
      await recordDeliveryFailure(database, contract.id, recipient.id, cause);
    }
  }
  return delivered;
}

/**
 * After a signature, sends the next signers their links in sequential
 * contracts, or completes the contract once everyone has signed.
 */
export async function advanceContract(
  environment: ContractEnvironment,
  contractId: string,
) {
  const contract = await findContractById(environment.DB, contractId);
  if (contract?.status !== "sent") return false;
  const recipients = await listRecipients(environment.DB, contract.id);
  if (
    recipients.length > 0 &&
    recipients.every(({ status }) => status === "signed")
  ) {
    return completeContract(environment, contract, recipients);
  }
  const awaiting = recipients.filter(
    ({ status }) => status === "sent" || status === "viewed",
  );
  const pending = recipients.filter(({ status }) => status === "pending");
  if (awaiting.length === 0 && pending.length > 0) {
    const next = Math.min(...pending.map(({ routing_order }) => routing_order));
    await notifyRecipients(
      environment,
      contract,
      pending.filter(({ routing_order }) => routing_order === next),
      false,
    );
  }
  return false;
}

/** The signers whose turn it is in a newly sent contract. */
export function firstSigners(
  contract: Pick<ContractRow, "signing_order">,
  recipients: RecipientRow[],
) {
  if (contract.signing_order === "parallel" || recipients.length === 0) {
    return recipients;
  }
  const first = Math.min(
    ...recipients.map(({ routing_order }) => routing_order),
  );
  return recipients.filter(({ routing_order }) => routing_order === first);
}

/**
 * Stamps the signed PDF, stores it, marks the contract completed exactly once,
 * and emails everyone a copy.
 */
async function completeContract(
  environment: ContractEnvironment,
  contract: ContractRow,
  recipients: RecipientRow[],
) {
  const database = environment.DB;
  const original = await environment.STORAGE.get(contract.document_object_key);
  if (!original) throw new Error("The contract document is missing.");
  const [fields, events, mail] = await Promise.all([
    listFields(database, contract.id),
    listEvents(database, contract.id),
    mailFor(database, contract),
  ]);
  const completedAt = new Date().toISOString();
  const signed = await stampContract(
    new Uint8Array(await original.arrayBuffer()),
    stampedFields(fields, recipients, completedAt),
    certificateFor(contract, recipients, events, mail, completedAt),
  );
  // A unique key per attempt: if two last signatures race, the loser's copy
  // is discarded rather than overwriting the winner's recorded hash.
  const finalKey = `organizations/${contract.organization_id}/contracts/${contract.id}/signed-${crypto.randomUUID()}.pdf`;
  await trackedPut(
    environment,
    {
      cleanupId: `contract-final-upload:${crypto.randomUUID()}`,
      key: finalKey,
      organizationId: contract.organization_id,
    },
    signed,
    {
      customMetadata: {
        contractId: contract.id,
        organizationId: contract.organization_id,
      },
      httpMetadata: { contentType: "application/pdf" },
    },
  );
  const completed = await database
    .prepare(
      `UPDATE contracts
       SET status = 'completed', completed_at = ?, final_object_key = ?,
           final_sha256 = ?, updated_at = ?
       WHERE id = ? AND status = 'sent' AND ${uploadStillQueued}`,
    )
    .bind(
      completedAt,
      finalKey,
      await sha256Hex(signed),
      completedAt,
      contract.id,
      finalKey,
    )
    .run();
  if (!completed.meta.changes) {
    await environment.STORAGE.delete(finalKey);
    return false;
  }
  await recordEvent(database, { contractId: contract.id, type: "completed" });
  await deliverCompletion(environment, contract, recipients, mail, signed);
  return true;
}

/** What to draw for each field: adopted images, dates, names, and text. */
function stampedFields(
  fields: FieldRow[],
  recipients: RecipientRow[],
  completedAt: string,
) {
  const byId = new Map(
    recipients.map((recipient) => [recipient.id, recipient]),
  );
  const images = new Map<string, Uint8Array>();
  const imageFor = (dataUrl: string | null) => {
    if (!dataUrl) return undefined;
    const image = images.get(dataUrl) ?? decodePngDataUrl(dataUrl);
    if (!image) return undefined;
    images.set(dataUrl, image);
    return image;
  };
  return fields.flatMap((field): StampedField[] => {
    const signer = byId.get(field.recipient_id);
    if (!signer) return [];
    const rect = {
      height: field.height,
      width: field.width,
      x: field.x,
      y: field.y,
    };
    if (field.type === "signature" || field.type === "initials") {
      const image = imageFor(
        field.type === "signature"
          ? signer.signature_image
          : signer.initials_image,
      );
      return [{ image, page: field.page, rect }];
    }
    const text =
      field.type === "date_signed"
        ? formatSignedDate(signer.signed_at ?? completedAt)
        : field.type === "name"
          ? signer.name
          : (field.value ?? "");
    return text ? [{ page: field.page, rect, text }] : [];
  });
}

function certificateFor(
  contract: ContractRow,
  recipients: RecipientRow[],
  events: EventRow[],
  mail: ContractMail,
  completedAt: string,
): Certificate {
  const byId = new Map(
    recipients.map((recipient) => [recipient.id, recipient]),
  );
  return {
    completedAt,
    contractId: contract.id,
    documentFilename: contract.document_filename,
    documentPageCount: contract.document_page_count,
    documentSha256: contract.document_sha256,
    events: [
      ...events.map((event) => ({
        at: event.created_at,
        description: describeEvent(event, byId),
      })),
      { at: completedAt, description: "Completed: every signer has signed" },
    ],
    organizationName: mail.organizationName,
    sentAt: contract.sent_at ?? completedAt,
    signers: recipients.map((recipient) => ({
      email: recipient.email,
      ip: recipient.signed_ip,
      name: recipient.name,
      signedAt: recipient.signed_at ?? completedAt,
      userAgent: recipient.signed_user_agent,
    })),
    title: contract.title,
  };
}

/**
 * Emails the signed PDF to each signer, with their own link back to it, and
 * to the sender when they did not sign.
 */
async function deliverCompletion(
  environment: ContractEnvironment,
  contract: ContractRow,
  recipients: RecipientRow[],
  mail: ContractMail,
  signed: Uint8Array,
) {
  const filename = signedFilename(contract.document_filename);
  const deliveries: Array<{
    link: string | null;
    person: { email: string; name: string };
    recipientId: string | null;
  }> = [];
  for (const recipient of recipients) {
    deliveries.push({
      link: await recipientLink(environment, recipient),
      person: recipient,
      recipientId: recipient.id,
    });
  }
  const sender = mail.sender;
  if (
    sender &&
    !recipients.some(
      ({ email }) => email.toLowerCase() === sender.email.toLowerCase(),
    )
  ) {
    deliveries.push({
      link: contractUrl(environment, contract.id),
      person: sender,
      recipientId: null,
    });
  }
  for (const { link, person, recipientId } of deliveries) {
    if (!link) continue;
    try {
      await sendCompletion(environment, mail, person, link, signed, filename);
    } catch (cause) {
      await recordDeliveryFailure(
        environment.DB,
        contract.id,
        recipientId,
        cause,
      );
    }
  }
}

async function recordDeliveryFailure(
  database: D1Database,
  contractId: string,
  recipientId: string | null,
  cause: unknown,
) {
  console.error("Contract email could not be sent.", cause);
  await recordEvent(database, {
    contractId,
    detail: cause instanceof Error ? cause.message : null,
    recipientId,
    type: "delivery_failed",
  });
}

/** A readable audit line for the certificate. */
function describeEvent(
  event: EventRow,
  recipients: Map<string, Pick<RecipientRow, "email" | "name">>,
) {
  const recipient = event.recipient_id
    ? recipients.get(event.recipient_id)
    : undefined;
  const who = recipient ? `${recipient.name} <${recipient.email}>` : "a signer";
  const actor = event.actor_name ?? "an organization member";
  switch (event.type) {
    case "created_from_template":
      return `Created by ${actor} from ${event.detail ?? "a template"}`;
    case "created":
      return `Created by ${actor}`;
    case "sent":
      return `Sent for signature by ${actor}`;
    case "notified":
      return `Signing request emailed to ${who}`;
    case "reminded":
      return `Reminder emailed to ${who}`;
    case "viewed":
      return `Viewed by ${who}${event.ip ? ` from ${event.ip}` : ""}`;
    case "signed":
      return `Signed by ${who}${event.ip ? ` from ${event.ip}` : ""}`;
    case "declined":
      return `Declined by ${who}`;
    case "voided":
      return `Voided by ${actor}`;
    case "delivery_failed":
      return `Email to ${who} could not be delivered`;
    default:
      return event.type;
  }
}

/** Decodes a signature adopted as a PNG data URL, or null if it is not one. */
export function decodePngDataUrl(value: string) {
  const prefix = "data:image/png;base64,";
  if (!value.startsWith(prefix)) return null;
  try {
    const binary = atob(value.slice(prefix.length));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => bytes[index] === byte)
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function formatSignedDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function signedFilename(filename: string) {
  const base = filename.replace(/\.pdf$/i, "");
  return `${base} (signed).pdf`;
}
