/**
 * Whether a parsed JSON value is an object rather than an array or a
 * primitive. Name the fields to read as Key; their values stay unchecked.
 */
export function isRecord<Key extends string = never>(
  value: unknown,
): value is Record<string, unknown> & Partial<Record<Key, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string with visible text no longer than maxLength once trimmed. */
export function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}
