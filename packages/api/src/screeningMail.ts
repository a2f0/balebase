import { productName } from "@balebase/ui/brand";
import { sendMail } from "./shared/mailSender";
import type { Bindings } from "./types";

type MailEnvironment = Pick<
  Bindings,
  "AUTH_EMAIL_FROM" | "CORS_ORIGIN" | "EMAIL"
>;

export interface ScreeningRequestMail {
  dueDate: string;
  /** The person's member ID, or null while they are still invited. */
  memberId: string | null;
  organizationId: string;
  organizationName: string;
  recipient: { email: string; name: string };
  requirementId: string;
  title: string;
}

/**
 * A page in My documents, such as the one where the person completes their
 * background check. It names the organization, which the app switches to
 * when another one is active.
 */
function myDocumentsUrl(
  environment: Pick<Bindings, "CORS_ORIGIN">,
  organizationId: string,
  path = "",
) {
  const url = new URL(`/me${path}`, environment.CORS_ORIGIN);
  url.searchParams.set("organization", organizationId);
  return url.toString();
}

/** Asks the person to complete a background check that a manager requested. */
export function sendScreeningRequest(
  environment: MailEnvironment,
  mail: ScreeningRequestMail,
) {
  const due = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${mail.dueDate}T12:00:00Z`));
  const link = myDocumentsUrl(
    environment,
    mail.organizationId,
    mail.memberId ? `/screening/${encodeURIComponent(mail.requirementId)}` : "",
  );
  return sendScreeningMail(environment, mail, {
    heading: "Your background check",
    subject: `${mail.organizationName} requested a background check`,
    paragraphs: [
      `Hi ${mail.recipient.name},`,
      `${mail.organizationName} asked you to complete “${mail.title}”, a background check through Checkr. Please complete it by ${due}.`,
      mail.memberId
        ? `Review the disclosures, enter your details, and sign the authorization in ${productName}.`
        : `Accept your invitation to ${mail.organizationName} first. The check then appears in My documents.`,
      `${productName} sends your details to Checkr only after you sign.`,
    ],
    link,
    action: "Open My documents",
  });
}

type ScreeningMail = Pick<
  ScreeningRequestMail,
  | "organizationId"
  | "organizationName"
  | "recipient"
  | "requirementId"
  | "title"
>;

/** Reports completion only, never an eligibility or hiring decision. */
export function sendScreeningComplete(
  environment: MailEnvironment,
  mail: ScreeningMail,
) {
  return sendScreeningMail(environment, mail, {
    heading: "Your background report is ready",
    subject: `${mail.organizationName}: your background report is ready`,
    paragraphs: [
      `Hi ${mail.recipient.name},`,
      `Checkr has finished “${mail.title}” for ${mail.organizationName}.`,
      `${mail.organizationName} reviews the report and contacts you about next steps. A completed report is not a hiring decision.`,
      `View your screening status and signed authorization in ${productName}. Checkr handles access to your report and any corrections or disputes.`,
    ],
    link: myDocumentsUrl(
      environment,
      mail.organizationId,
      `/screening/${encodeURIComponent(mail.requirementId)}`,
    ),
    action: "View screening status",
  });
}

function sendScreeningMail(
  environment: MailEnvironment,
  mail: ScreeningMail,
  message: {
    action: string;
    heading: string;
    link: string;
    paragraphs: string[];
    subject: string;
  },
) {
  const footer =
    "Background screening provided by Checkr. Checkr may also email you about your report or ask for additional information.";
  const logo = new URL(
    "/apple-touch-icon.png",
    environment.CORS_ORIGIN,
  ).toString();
  return sendMail(environment, {
    organizationName: mail.organizationName,
    subject: message.subject,
    text: [
      ...message.paragraphs,
      `${message.action}:\n${message.link}`,
      footer,
    ].join("\n\n"),
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f6f6f2;color:#181916;font-family:Arial,sans-serif">
      <table role="presentation" style="width:100%;max-width:600px;margin:32px auto;background:#fff;border:1px solid #deded5;border-radius:12px"><tr><td style="padding:32px">
        <img src="${escapeHtml(logo)}" alt="" width="40" height="40" style="vertical-align:middle;border-radius:8px">
        <span style="font-size:22px;font-weight:bold;vertical-align:middle">${escapeHtml(productName)}</span>
        <h1 style="font-size:26px;line-height:1.25;margin-top:28px">${escapeHtml(message.heading)}</h1>
        ${message.paragraphs.map((paragraph) => `<p style="line-height:1.6">${escapeHtml(paragraph)}</p>`).join("")}
        <p style="margin:28px 0"><a href="${escapeHtml(message.link)}" style="display:inline-block;padding:14px 20px;background:#b7ff5b;color:#181916;text-decoration:none;border-radius:8px;font-weight:bold">${escapeHtml(message.action)}</a></p>
        <p style="font-size:13px;line-height:1.5;color:#666">${escapeHtml(footer)}</p>
      </td></tr></table></body></html>`,
    to: { email: mail.recipient.email, name: mail.recipient.name },
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
