import { describe, expect, it } from "bun:test";
import { ApiError } from "@balebase/api-client";
import {
  seatRequirementFrom,
  twoFactorRequirementFrom,
} from "./organizationAccessErrors";

function apiError(error: string, code: string) {
  return new ApiError(new Response(null, { status: 403 }), { code, error });
}

describe("organization API errors", () => {
  it("identifies two-factor setup and verification requirements", () => {
    expect(
      twoFactorRequirementFrom(apiError("setup", "TWO_FACTOR_SETUP_REQUIRED")),
    ).toBe("setup");
    expect(
      twoFactorRequirementFrom(
        apiError("verification", "TWO_FACTOR_VERIFICATION_REQUIRED"),
      ),
    ).toBe("verification");
    expect(twoFactorRequirementFrom(new Error("unrelated"))).toBeUndefined();
  });

  it("tells owners who can upgrade apart from members without a seat", () => {
    expect(seatRequirementFrom(apiError("upgrade", "UPGRADE_REQUIRED"))).toBe(
      "upgrade",
    );
    expect(seatRequirementFrom(apiError("no seat", "SEAT_UNAVAILABLE"))).toBe(
      "ask-owner",
    );
    expect(
      seatRequirementFrom(apiError("setup", "TWO_FACTOR_SETUP_REQUIRED")),
    ).toBeUndefined();
    expect(seatRequirementFrom(new Error("unrelated"))).toBeUndefined();
  });
});
