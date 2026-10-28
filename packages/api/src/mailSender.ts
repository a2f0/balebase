import { productName } from "@balebase/ui/brand";
import type { Bindings } from "./types";

interface Mail extends Omit<EmailReplyMessageBuilder, "from" | "replyTo"> {
  /** The organization the mail is sent for, named as "Acme via <product>". */
  organizationName?: string;
  replyTo?: string;
  to: string | EmailAddress;
}

/** Sends product mail from AUTH_EMAIL_FROM under the product's name. */
export function sendMail(
  environment: Pick<Bindings, "AUTH_EMAIL_FROM" | "EMAIL">,
  { organizationName, subject, ...message }: Mail,
) {
  const name = organizationName
    ? `${organizationName} via ${productName}`
    : productName;
  return environment.EMAIL.send({
    ...message,
    from: { email: environment.AUTH_EMAIL_FROM, name: name.slice(0, 100) },
    subject: subject.slice(0, 250),
  });
}
