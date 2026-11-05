import { describe, expect, it } from "bun:test";
import { revokedFinanceScope } from "./useRevokedFinanceCleanup";

const lacking = { can: () => false, confirmed: true };

describe("revoked finance cleanup", () => {
  it("clears only access that was read and lacks Finance", () => {
    expect(revokedFinanceScope("person", "org", lacking)).toEqual({
      organizationId: "org",
      userId: "person",
    });
    // Access that failed to load reports no capabilities; it is not a loss.
    expect(
      revokedFinanceScope("person", "org", { ...lacking, confirmed: false }),
    ).toBeUndefined();
    expect(
      revokedFinanceScope("person", "org", { ...lacking, can: () => true }),
    ).toBeUndefined();
    expect(revokedFinanceScope(undefined, "org", lacking)).toBeUndefined();
    expect(revokedFinanceScope("person", undefined, lacking)).toBeUndefined();
  });
});
