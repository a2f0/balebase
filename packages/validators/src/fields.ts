import { z } from "zod";

/** Text with something visible in it, trimmed, at most `max` characters. */
export function requiredText(max: number) {
  return z.string().trim().min(1).max(max);
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
) {
  return z.union([z.null(), blank, rule]).optional();
}

/** A real calendar day as YYYY-MM-DD. */
export const CalendarDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    );
  });
