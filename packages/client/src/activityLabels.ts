export function assigneeLabel(id: unknown, name: unknown, email: unknown) {
  return id == null
    ? "Unassigned"
    : textValue(name) || textValue(email) || textValue(id);
}

/** Display text for a value read from an event's untyped details. */
export function textValue(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}
