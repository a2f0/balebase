export function organizationInboxAddress(
  organizationId: string,
  inboundEmailDomain: string,
) {
  return `upload+${organizationId}@${normalizeDomain(inboundEmailDomain)}`;
}

function organizationIdForInboundAddress(
  address: string,
  inboundEmailDomain: string,
) {
  const separator = address.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const domain = address.slice(separator + 1).toLowerCase();
  if (domain !== normalizeDomain(inboundEmailDomain)) return undefined;
  const localPart = address.slice(0, separator);
  const prefix = "upload+";
  if (!localPart.toLowerCase().startsWith(prefix)) return undefined;
  return localPart.slice(prefix.length) || undefined;
}

function normalizeDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

export function forwardingAddress(id: string, inboundDomain: string) {
  return `inbox+${id}@${normalizeDomain(inboundDomain)}`;
}

export function isPlatformDomain(domain: string, inboundDomain: string) {
  return (
    domain === "balebase.com" ||
    domain.endsWith(".balebase.com") ||
    domain === normalizeDomain(inboundDomain)
  );
}

export function platformRecipients(inboundDomain: string) {
  const domain =
    inboundDomain === "inbox-staging.balebase.com"
      ? inboundDomain
      : "balebase.com";
  return [`legal@${domain}`, `privacy@${domain}`];
}

export async function resolveRecipient(
  db: D1Database,
  address: string,
  inboundDomain: string,
  platformOrganizationId?: string,
): Promise<{ organizationId: string; mailboxId: string | null } | null> {
  const uploadOrganization = organizationIdForInboundAddress(
    address,
    inboundDomain,
  );
  if (uploadOrganization) {
    const org = await db
      .prepare("SELECT id FROM organization WHERE id = ? AND deletedAt IS NULL")
      .bind(uploadOrganization)
      .first<{ id: string }>();
    return org ? { organizationId: org.id, mailboxId: null } : null;
  }

  const normalized = address.toLowerCase();
  const [local, domain, extra] = normalized.split("@");
  if (!local || !domain || extra !== undefined) return null;
  const forwarding =
    domain === normalizeDomain(inboundDomain) && local.startsWith("inbox+");
  return db
    .prepare(
      `SELECT box.organization_id AS organizationId, box.id AS mailboxId
     FROM inbound_mailboxes box JOIN organization org ON org.id = box.organization_id
     WHERE org.deletedAt IS NULL AND box.disconnected_at IS NULL
       AND (box.address NOT IN (?, ?) OR box.organization_id = ?)
       AND ${forwarding ? "box.forwarding_id" : "box.address"} = ?`,
    )
    .bind(
      ...platformRecipients(inboundDomain),
      platformOrganizationId ?? null,
      forwarding ? local.slice("inbox+".length) : normalized,
    )
    .first<{ organizationId: string; mailboxId: string }>();
}
