import { expect, test } from "bun:test";
import { releaseTier } from "./config";

test("the tier defaults to production and rejects unknown names", () => {
  expect(releaseTier("VITE_RELEASE_TIER", undefined)).toBe("production");
  expect(releaseTier("VITE_RELEASE_TIER", " Staging ")).toBe("staging");
  expect(() => releaseTier("PUBLIC_RELEASE_TIER", "prod")).toThrow(
    'Unknown PUBLIC_RELEASE_TIER="prod". Expected production or staging.',
  );
});
