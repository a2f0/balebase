import { describe, expect, it } from "bun:test";
import type { AuditDetail } from "@balebase/validators/audits";
import { act } from "react";
import { installDom } from "../testing/dom";
import { useAuditRun } from "./useAuditRun";

const { mount, respond, settle } = installDom({
  url: "http://localhost:5173/audits/run-1",
});

function detail(
  revision: number,
  status: "completed" | "in_progress",
  issueTitles: string[] = [],
): AuditDetail {
  return {
    audit: {
      answerActivity: {},
      completedAt: null,
      createdAt: "2026-10-02T12:00:00.000Z",
      createdBy: { email: "sam@example.com", id: "user-1", name: "Sam" },
      deletedAt: null,
      deletedBy: null,
      definition: { sections: [], version: 1 },
      id: "run-1",
      project: { deleted: false, id: "project-1", name: "Riverside clinic" },
      responses: {},
      revision,
      status,
      templateId: null,
      templateName: "Fire safety",
      templateVersion: 1,
      updatedAt: "2026-10-02T12:00:00.000Z",
    },
    issues: issueTitles.map(
      (title) => ({ id: title, title }) as unknown as AuditDetail["issues"][0],
    ),
    members: [],
  };
}

/** Serves reads in order, each held until the test releases it. */
function heldReads() {
  const reads: Array<PromiseWithResolvers<AuditDetail | Error>> = [];
  respond(async () => {
    const read = Promise.withResolvers<AuditDetail | Error>();
    reads.push(read);
    const result = await read.promise;
    return result instanceof Error
      ? Response.json({ error: result.message }, { status: 503 })
      : Response.json(result);
  });
  return reads;
}

let latestRun: ReturnType<typeof useAuditRun> | undefined;

function Harness() {
  latestRun = useAuditRun("run-1");
  return null;
}

async function mountRun() {
  await mount(<Harness />);
  return () => {
    if (!latestRun) throw new Error("Not mounted");
    return latestRun;
  };
}

/** Starts a read and lets its request go out. */
async function start(read: () => Promise<void>) {
  await act(async () => {
    void read();
    await Bun.sleep(1);
  });
}

async function release(
  read: PromiseWithResolvers<AuditDetail | Error> | undefined,
  value: AuditDetail | Error,
) {
  if (!read) throw new Error("No read to release");
  await act(async () => {
    read.resolve(value);
    await settle();
  });
}

describe("audit run reads", () => {
  it("keeps a full reload's audit when an issues refresh replaces it", async () => {
    const reads = heldReads();
    const run = await mountRun();
    await release(reads[0], detail(1, "in_progress"));
    // A save's reload, then an issue change's refresh before it returns.
    await start(() => run().load());
    await start(() => run().refreshIssues());
    expect(reads).toHaveLength(3);
    await release(reads[1], detail(2, "completed"));
    await release(reads[2], detail(2, "completed", ["Exit blocked"]));
    expect(run().detail?.audit.revision).toBe(2);
    expect(run().detail?.audit.status).toBe("completed");
    expect(run().detail?.issues).toHaveLength(1);
  });

  it("clears a failed reload's error once a later read lands", async () => {
    const reads = heldReads();
    const run = await mountRun();
    await release(reads[0], detail(1, "in_progress"));
    await start(() => run().load());
    await release(reads[1], new Error("Try again."));
    expect(run().loadError).toBe("Try again.");
    // The refresh after a failed reload reads the whole audit again.
    await start(() => run().refreshIssues());
    await release(reads[2], detail(2, "completed"));
    expect(run().loadError).toBeUndefined();
    expect(run().detail?.audit.revision).toBe(2);
  });
});
