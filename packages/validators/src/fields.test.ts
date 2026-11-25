import { describe, expect, it } from "bun:test";
import { DefinitionIdSchema } from "./fields";

describe("definition IDs", () => {
  it("keeps padding and measures only the visible ID", () => {
    const padded = ` ${"a".repeat(100)} `;
    expect(DefinitionIdSchema.parse(padded)).toBe(padded);
    expect(DefinitionIdSchema.safeParse("a".repeat(101)).success).toBe(false);
    expect(DefinitionIdSchema.safeParse("   ").success).toBe(false);
  });
});
