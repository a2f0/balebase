import { z } from "zod";

/** A person a record names, such as its creator or assignee. */
export const PersonSchema = z.object({
  email: z.string(),
  id: z.string(),
  name: z.string(),
});
export type Person = z.infer<typeof PersonSchema>;

/**
 * Text with something visible in it, trimmed, at most `max` characters.
 * `rule`, when given, is the message for any text that breaks it.
 */
export function requiredText(max: number, rule?: string) {
  const error = rule === undefined ? {} : { error: rule };
  return z.string(error).trim().min(1, error).max(max, error);
}

/**
 * A name on one line: NUL characters are dropped, runs of whitespace become
 * one space, and the trimmed result has 1 to `max` characters. `rule`
 * describes the limit to people.
 */
export function lineName(max: number, rule: string) {
  return z
    .string({ error: rule })
    .overwrite((name) => name.replaceAll("\0", "").trim().replace(/\s+/g, " "))
    .min(1, rule)
    .max(max, rule);
}

/** The ID of a record that the request points at. */
export const RecordIdSchema = z.string().min(1).max(100);

const blank = z
  .string()
  .trim()
  .max(0)
  .transform(() => null);

/**
 * An optional field sent as text. Absent stays undefined, so an update keeps
 * the stored value; null or blank text is null, which clears it. Any other
 * text must pass `rule`, which trims it first.
 */
export function optionalText<Rule extends z.ZodType<unknown, string>>(
  rule: Rule,
  invalid?: string,
) {
  const choices = [z.null(), blank, rule] as const;
  return (
    invalid === undefined
      ? z.union(choices)
      : z.union(choices, { error: invalid })
  ).optional();
}

/** Every field a schema accepts, present, as a form holds them. */
export type FormInput<Schema extends z.ZodType> = {
  [Field in keyof z.input<Schema>]-?: Exclude<
    z.input<Schema>[Field],
    undefined
  >;
};

/** A real calendar day as YYYY-MM-DD; `rule` is the message otherwise. */
export function calendarDate(rule?: string) {
  const error = rule === undefined ? {} : { error: rule };
  return z
    .string(error)
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, error)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(date.valueOf()) &&
        date.toISOString().slice(0, 10) === value
      );
    }, error);
}
