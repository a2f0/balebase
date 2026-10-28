import { describe, expect, it } from "bun:test";
import { businessesRoutes } from "./businesses";

const { body } = businessesRoutes.create;

function parsed(field: string, value: string) {
  const result = body.safeParse({ name: "Acme", [field]: value });
  return result.success
    ? result.data[field as keyof typeof result.data]
    : "invalid";
}

describe("business input", () => {
  it("stores only valid nine-digit EINs, without the dash", () => {
    expect(parsed("ein", "12-3456789")).toBe("123456789");
    expect(parsed("ein", " 123456789 ")).toBe("123456789");
    expect(parsed("ein", "12 3456789")).toBe("invalid");
    expect(parsed("ein", "12345678")).toBe("invalid");
    expect(parsed("ein", "12-345678a")).toBe("invalid");
  });

  it("stores only nine-digit DUNS numbers, bare or fully grouped", () => {
    expect(parsed("duns", "12-345-6789")).toBe("123456789");
    expect(parsed("duns", " 123456789 ")).toBe("123456789");
    expect(parsed("duns", "12-3456789")).toBe("invalid");
    expect(parsed("duns", "12 345 6789")).toBe("invalid");
    expect(parsed("duns", "12345678")).toBe("invalid");
  });

  it("accepts only real calendar dates", () => {
    expect(parsed("incorporationDate", " 2024-02-29 ")).toBe("2024-02-29");
    expect(parsed("incorporationDate", "2026-02-29")).toBe("invalid");
    expect(parsed("incorporationDate", "2026-13-01")).toBe("invalid");
    expect(parsed("incorporationDate", "08/22/2026")).toBe("invalid");
  });

  it("capitalizes state codes and checks ZIP codes", () => {
    expect(parsed("state", " ny ")).toBe("NY");
    expect(parsed("state", "New York")).toBe("invalid");
    expect(parsed("state", "N1")).toBe("invalid");
    expect(parsed("zip", " 10001 ")).toBe("10001");
    expect(parsed("zip", "10001-1234")).toBe("10001-1234");
    expect(parsed("zip", "1000")).toBe("invalid");
    expect(parsed("zip", "A0001")).toBe("invalid");
  });

  it("clears blank or null fields and leaves absent ones out", () => {
    expect(body.parse({ city: "  ", ein: null, name: " Acme " })).toEqual({
      city: null,
      ein: null,
      name: "Acme",
    });
  });
});
