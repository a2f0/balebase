import { describe, expect, it } from "bun:test";
import { OfflineOperationSchema } from "./offline";

describe("offline operations", () => {
  it("parses an issue exactly as earlier releases did, so receipts still match", () => {
    const operation = {
      assignedTo: null,
      auditId: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
      description: "  Wobbles at the top.  ",
      id: "8f0c6d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
      itemId: " check ",
      priority: "high",
      title: "  Loose rail  ",
      type: "issue",
    };
    // What 0.1.86 hashed for this operation; a change here breaks retries.
    expect(JSON.stringify(OfflineOperationSchema.parse(operation))).toBe(
      '{"id":"8f0c6d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f","type":"issue","title":"Loose rail","description":"  Wobbles at the top.  ","priority":"high","assignedTo":null,"auditId":"1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b","itemId":" check "}',
    );
  });

  it("parses audit writes in a fixed key order, so retries hash the same", () => {
    const start = {
      answers: { check: { at: "2026-11-10T12:00:00.000Z", value: "pass" } },
      templateVersion: 3,
      templateId: "form",
      projectId: "project",
      type: "auditStart",
      id: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
    };
    expect(JSON.stringify(OfflineOperationSchema.parse(start))).toBe(
      '{"id":"1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b","type":"auditStart","projectId":"project","templateId":"form","templateVersion":3,"answers":{"check":{"value":"pass","at":"2026-11-10T12:00:00.000Z"}}}',
    );
    const save = {
      completion: {
        completedAt: "2026-11-10T12:30:00.000Z",
        startedAt: "2026-11-10T12:00:00.000Z",
      },
      answers: {
        check: {
          base: "2026-11-10T12:00:00.000Z",
          at: "2026-11-10T12:20:00.000Z",
          value: " fail ",
        },
      },
      auditId: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b",
      type: "auditSave",
      id: "8f0c6d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
    };
    expect(JSON.stringify(OfflineOperationSchema.parse(save))).toBe(
      '{"id":"8f0c6d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f","type":"auditSave","auditId":"1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b","answers":{"check":{"value":" fail ","at":"2026-11-10T12:20:00.000Z","base":"2026-11-10T12:00:00.000Z"}},"completion":{"startedAt":"2026-11-10T12:00:00.000Z","completedAt":"2026-11-10T12:30:00.000Z"}}',
    );
  });
});
