import { expect, it } from "bun:test";
import { signingRoutes } from "./signing";

it("requires consent and bounds each typed value", () => {
  const sign = signingRoutes.sign.body;
  const consentRule = "Agree to use electronic records and signatures to sign.";
  for (const consent of [false, undefined, "yes"]) {
    expect(sign.safeParse({ consent }).error?.issues[0]?.message).toBe(
      consentRule,
    );
  }
  expect(
    sign.safeParse({ consent: true, values: { field: "a".repeat(501) } }).error
      ?.issues[0]?.message,
  ).toBe("A field's text is too long.");
  expect(
    sign.parse({ consent: true, values: { field: ` ${"a".repeat(500)} ` } })
      .values,
  ).toEqual({ field: "a".repeat(500) });
});

it("cuts a decline reason short rather than refusing it", () => {
  const decline = signingRoutes.decline.body;
  expect(decline.parse({}).reason).toBe("");
  expect(decline.parse({ reason: `  ${"b".repeat(600)}` }).reason).toBe(
    "b".repeat(500),
  );
  expect(decline.safeParse(null).success).toBe(false);
});
