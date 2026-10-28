import type { ContractDraft } from "@balebase/validators/contracts";
import type { ContractRow } from "./contractRecords";

export const offPageError = "A field is on a page the document doesn't have.";

/** Whether every field is on a page the document has. */
export function fieldsOnDocument(
  fields: Array<{ page: number }>,
  pageCount: number,
) {
  return fields.every(({ page }) => page <= pageCount);
}

/**
 * The statements that replace a draft's details, signers, and fields. Each
 * re-checks that the contract is still a draft, so a save racing a send
 * cannot replace the recipients who were just emailed.
 */
export function draftStatements(
  database: D1Database,
  contract: Pick<ContractRow, "id" | "organization_id">,
  draft: ContractDraft,
  now: string,
) {
  const recipientIds = new Map(
    draft.recipients.map((recipient) => [recipient.key, crypto.randomUUID()]),
  );
  const stillDraft = `EXISTS (
    SELECT 1 FROM contracts WHERE id = ? AND status = 'draft'
  )`;
  return [
    database
      .prepare(
        `UPDATE contracts
         SET title = ?, message = ?, signing_order = ?, due_date = ?,
             reminder_interval_days = ?, updated_at = ?,
             revision = revision + 1
         WHERE id = ? AND organization_id = ? AND status = 'draft'`,
      )
      .bind(
        draft.title,
        draft.message,
        draft.signingOrder,
        draft.dueDate,
        draft.reminderIntervalDays,
        now,
        contract.id,
        contract.organization_id,
      ),
    database
      .prepare(
        `DELETE FROM contract_fields WHERE contract_id = ? AND ${stillDraft}`,
      )
      .bind(contract.id, contract.id),
    database
      .prepare(
        `DELETE FROM contract_recipients
         WHERE contract_id = ? AND ${stillDraft}`,
      )
      .bind(contract.id, contract.id),
    ...draft.recipients.map((recipient) =>
      database
        .prepare(
          `INSERT INTO contract_recipients
             (id, contract_id, organization_id, name, email, routing_order,
              created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${stillDraft}`,
        )
        .bind(
          recipientIds.get(recipient.key) ?? "",
          contract.id,
          contract.organization_id,
          recipient.name,
          recipient.email,
          draft.signingOrder === "parallel" ? 1 : recipient.routingOrder,
          now,
          contract.id,
        ),
    ),
    ...draft.fields.map((field) =>
      database
        .prepare(
          `INSERT INTO contract_fields
             (id, contract_id, recipient_id, type, page, x, y, width, height,
              required, label)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${stillDraft}`,
        )
        .bind(
          crypto.randomUUID(),
          contract.id,
          recipientIds.get(field.recipientKey) ?? "",
          field.type,
          field.page,
          field.x,
          field.y,
          field.width,
          field.height,
          field.required ? 1 : 0,
          field.label,
          contract.id,
        ),
    ),
  ];
}

export function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
