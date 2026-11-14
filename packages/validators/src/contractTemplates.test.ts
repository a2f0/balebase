import { describe, expect, it } from "bun:test";
import { contractTemplatesRoutes } from "./contractTemplates";

const authored: ReturnType<
  typeof contractTemplatesRoutes.createAuthored.body.parse
> = {
  name: "Services",
  description: "Reusable agreement",
  definition: {
    roles: [{ key: "client", label: "Client", routingOrder: 1 }],
    fields: [],
    message: "Review this agreement.",
    reminderIntervalDays: null,
    signingOrder: "parallel",
  },
  authoring: {
    formatVersion: 1,
    source: ':signature{#sig role="client"}',
    values: { "project.name": "Default project" },
  },
};

describe("contract template schemas", () => {
  it("creates only source and defaults, never recipient identities, due dates, or an initial publication", () => {
    const parsed = contractTemplatesRoutes.createAuthored.body.parse({
      ...authored,
      status: "published",
      expectedCurrentVersion: 8,
      sourceVersion: 7,
      dueDate: "2030-01-01",
      authoring: {
        ...authored.authoring,
        dueDate: "2030-01-01",
        recipients: [{ name: "Real person", email: "real@example.com" }],
      },
      definition: {
        ...authored.definition,
        roles: [
          {
            ...authored.definition.roles[0],
            name: "Real person",
            email: "real@example.com",
          },
        ],
      },
    });
    expect(parsed).toEqual(authored);
    expect(
      contractTemplatesRoutes.createAuthored.body.safeParse({
        ...authored,
        authoring: null,
      }).success,
    ).toBe(false);
  });

  it("uses the written-contract source and merge-value limits at both template and instantiation boundaries", () => {
    for (const patch of [
      { source: " " },
      { source: "x".repeat(50_001) },
      { formatVersion: 2 },
      { values: { "project.name": "x".repeat(2001) } },
      { values: { "invalid key": "value" } },
      {
        values: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`key${i}`, "value"]),
        ),
      },
    ]) {
      expect(
        contractTemplatesRoutes.createAuthored.body.safeParse({
          ...authored,
          authoring: { ...authored.authoring, ...patch },
        }).success,
      ).toBe(false);
      if ("values" in patch)
        expect(
          contractTemplatesRoutes.createContract.body.safeParse({
            version: 1,
            recipients: [],
            values: patch.values,
          }).success,
        ).toBe(false);
    }
    expect(
      contractTemplatesRoutes.createContract.body.parse({
        version: 2,
        recipients: [],
        values: { "project.name": "Per-use value" },
      }).values,
    ).toEqual({ "project.name": "Per-use value" });
  });

  it("keeps source and CAS versions distinct and only accepts publication actions on version saves", () => {
    const body = { ...authored, expectedCurrentVersion: 5, sourceVersion: 2 };
    expect(contractTemplatesRoutes.saveVersion.body.parse(body)).toEqual(body);
    for (const status of ["published", "unpublished"] as const)
      expect(
        contractTemplatesRoutes.saveVersion.body.parse({ ...body, status })
          .status,
      ).toBe(status);
    expect(
      contractTemplatesRoutes.saveVersion.body.safeParse({
        ...body,
        status: "draft",
      }).success,
    ).toBe(false);
    expect(
      contractTemplatesRoutes.saveVersion.body.safeParse({
        ...body,
        expectedCurrentVersion: undefined,
      }).success,
    ).toBe(false);
  });
});
