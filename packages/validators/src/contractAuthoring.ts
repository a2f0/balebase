import { z } from "zod";
import { calendarDate, optionalText, requiredText } from "./fields";
import { contractLimits } from "./rules";

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const valueKey = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/;

/** The source and resolved-input snapshot that generates one contract revision. */
export const ContractAuthoringSchema = z
  .object({
    formatVersion: z.literal(1),
    source: z
      .string()
      .max(50_000, "Keep the Markdown to 50,000 characters.")
      .refine(
        (source) => source.trim().length > 0,
        "Write the contract first.",
      ),
    title: requiredText(
      contractLimits.title,
      "Give the contract a title of up to 200 characters.",
    ),
    message: z.string().trim().max(contractLimits.message),
    dueDate: optionalText(calendarDate("The due date is invalid.")).transform(
      (date) => date ?? null,
    ),
    reminderIntervalDays: z
      .int()
      .min(1)
      .max(contractLimits.reminderDays)
      .nullable(),
    signingOrder: z.enum(["parallel", "sequential"]),
    recipients: z
      .array(
        z.object({
          key: z
            .string()
            .regex(
              identifier,
              "Use a role key beginning with a letter, followed by letters, numbers, hyphens or underscores.",
            ),
          name: z.string().trim().max(contractLimits.signerName),
          email: z.string().trim().max(contractLimits.signerEmail),
          routingOrder: z.int().min(1).max(contractLimits.signers),
        }),
      )
      .min(1, "Add at least one signer role.")
      .max(contractLimits.signers),
    values: z
      .record(
        z
          .string()
          .max(100)
          .regex(
            valueKey,
            "Use dotted names for merge values, such as project.name.",
          ),
        z.string().max(2000),
      )
      .refine(
        (values) => Object.keys(values).length <= 100,
        "Use at most 100 merge values.",
      ),
  })
  .superRefine((input, context) => {
    const keys = new Set<string>();
    const emails = new Set<string>();
    for (const recipient of input.recipients) {
      if (keys.has(recipient.key))
        context.addIssue("Each signer role needs a unique key.");
      keys.add(recipient.key);
      const email = recipient.email.toLowerCase();
      if (email && emails.has(email))
        context.addIssue(`${recipient.email} is listed more than once.`);
      if (email) emails.add(email);
      for (const property of ["name", "email"]) {
        if (Object.hasOwn(input.values, `${recipient.key}.${property}`))
          context.addIssue(
            `Set ${recipient.key}.${property} in its signer role, not in merge values.`,
          );
      }
    }
  });

export type ContractAuthoringInput = z.infer<typeof ContractAuthoringSchema>;
