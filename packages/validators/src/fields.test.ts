import { describe, expect, it } from "bun:test";
import { ChecklistIdSchema } from "./fields";

describe("checklist IDs", () => {
  it("keeps padding and measures only the visible ID", () => {
    const padded = ` ${"a".repeat(100)} `;
    expect(ChecklistIdSchema.parse(padded)).toBe(padded);
    expect(ChecklistIdSchema.safeParse("a".repeat(101)).success).toBe(false);
    expect(ChecklistIdSchema.safeParse("   ").success).toBe(false);
  });
});
