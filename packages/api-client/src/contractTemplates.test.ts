import { expect, it } from "bun:test";
import type { CreateAuthoredTemplateInput } from "@balebase/validators/contractTemplates";
import { ApiClient } from "./ApiClient";

it("sends authored source, publication CAS provenance, and per-use merge values through the existing template client", async () => {
  const requests: Array<{
    url: string;
    method: string | undefined;
    body: unknown;
  }> = [];
  const api = new ApiClient({
    baseUrl: "https://api.test",
    fetch: async (url, init) => {
      requests.push({
        url,
        method: init.method,
        body: JSON.parse(String(init.body)),
      });
      return Response.json(
        url.endsWith("/contracts")
          ? { contractId: "contract-1" }
          : { template: null },
        { status: 201 },
      );
    },
  });
  const input: CreateAuthoredTemplateInput = {
    name: "Written template",
    description: "Services",
    definition: {
      roles: [{ key: "client", label: "Client", routingOrder: 1 }],
      fields: [],
      message: "",
      reminderIntervalDays: null,
      signingOrder: "parallel",
    },
    authoring: {
      formatVersion: 1,
      source: ':signature{#sig role="client"}',
      values: { "project.name": "Default" },
    },
  };
  expect(await api.contractTemplates.createAuthored(input)).toBeNull();
  expect(
    await api.contractTemplates.saveVersion(
      { id: "template-1", currentVersion: 5, version: 2 },
      {
        ...input,
        status: "published",
      },
    ),
  ).toBeNull();
  const use = {
    version: 2,
    recipients: [
      { roleKey: "client", name: "Sam Signer", email: "sam@example.com" },
    ],
    values: { "project.name": "Actual project" },
  };
  expect(await api.contractTemplates.createContract("template-1", use)).toBe(
    "contract-1",
  );
  expect(requests).toEqual([
    {
      url: "https://api.test/api/contracts/templates/authored",
      method: "POST",
      body: input,
    },
    {
      url: "https://api.test/api/contracts/templates/template-1/versions",
      method: "POST",
      body: {
        ...input,
        status: "published",
        expectedCurrentVersion: 5,
        sourceVersion: 2,
      },
    },
    {
      url: "https://api.test/api/contracts/templates/template-1/contracts",
      method: "POST",
      body: use,
    },
  ]);
});
