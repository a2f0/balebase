import { describe, expect, it } from "bun:test";
import type { OrganizationCapability } from "@balebase/validators/organizationGroups";
import { capabilityGate } from "./capabilityGate";

function access(
  held: OrganizationCapability[],
  { paidFeaturesEnabled = true, requirementPending = false } = {},
) {
  return {
    can: (capability: OrganizationCapability) => held.includes(capability),
    confirmed: true,
    paidFeaturesEnabled,
    requirementPending,
  };
}

describe("capability gate", () => {
  it("opens pages to those whose groups grant their capability", () => {
    expect(capabilityGate("/finance", access(["finance"]))).toBeUndefined();
    expect(
      capabilityGate("/background-checks/c1", access(["background_checks"])),
    ).toBeUndefined();
    expect(capabilityGate("/projects", access([]))).toBeUndefined();
  });

  it("names the group membership a closed page needs", () => {
    expect(capabilityGate("/background-checks", access(["finance"]))).toEqual({
      message: expect.stringContaining(
        "Background checks group membership is required.",
      ),
      reason: "notInGroup",
    });
    expect(capabilityGate("/finance", access([]))).toEqual({
      message: "Finance group membership is required.",
      reason: "notInGroup",
    });
  });

  it("says paid features are off only for Finance", () => {
    const off = { paidFeaturesEnabled: false };
    expect(capabilityGate("/finance", access([], off))).toEqual({
      reason: "paidFeaturesDisabled",
    });
    expect(capabilityGate("/background-checks", access([], off))).toEqual({
      message: expect.stringContaining(
        "Background checks group membership is required.",
      ),
      reason: "notInGroup",
    });
  });

  it("leaves a seat or two-factor requirement to its own screen", () => {
    expect(
      capabilityGate(
        "/background-checks",
        access([], { requirementPending: true }),
      ),
    ).toBeUndefined();
  });
});
