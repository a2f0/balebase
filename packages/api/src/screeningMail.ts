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
 * The page where the person completes their background check. It names the
 * organization, which the app switches to when another one is active.
 */
function screeningFormUrl(
  environment: Pick<Bindings, "CORS_ORIGIN">,
  mail: Pick<ScreeningRequestMail, "organizationId" | "requirementId"> & {
    memberId: string;
  },
) {
  const url = new URL(
    `/organization/people/${encodeURIComponent(mail.memberId)}/screening/${encodeURIComponent(mail.requirementId)}`,
    environment.CORS_ORIGIN,
  );
  url.searchParams.set("organization", mail.organizationId);
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
  return environment.EMAIL.send({
    from: {
      email: environment.AUTH_EMAIL_FROM,
      name: `${mail.organizationName} via Balebase`.slice(0, 100),
    },
    subject: `${mail.organizationName} requested a background check`.slice(
      0,
      250,
    ),
    text: [
      `Hi ${mail.recipient.name},`,
      "",
      `${mail.organizationName} asked you to complete “${mail.title}”, a background check through Checkr. Please complete it by ${due}.`,
      "",
      ...(mail.memberId
        ? [
            "Review the disclosures, enter your details, and sign the authorization in Balebase:",
            screeningFormUrl(environment, { ...mail, memberId: mail.memberId }),
          ]
        : [
            `Accept your invitation to ${mail.organizationName} first. The check then appears on your page under Organization → People:`,
            new URL("/", environment.CORS_ORIGIN).toString(),
          ]),
      "",
      "Balebase sends your details to Checkr only after you sign.",
    ].join("\n"),
    to: { email: mail.recipient.email, name: mail.recipient.name },
  });
}
