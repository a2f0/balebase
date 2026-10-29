import { describe, expect, it } from "bun:test";
import { api } from "../shared/apiClient";
import { installFetch } from "../testing/fetch";

const respond = installFetch();

describe("contracts API", () => {
  it("runs a draft's saves in order and reads after them", async () => {
    const log: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    respond(async (_url, init) => {
      calls += 1;
      const call = calls;
      log.push(`start ${init?.method ?? "GET"}`);
      if (call === 1) await firstHeld;
      log.push(`end ${call}`);
      return Response.json({ contract: { id: "c1" } });
    });
    const draft = {
      dueDate: null,
      fields: [],
      message: "",
      recipients: [],
      reminderIntervalDays: null,
      signingOrder: "parallel" as const,
      title: "Lease",
    };
    const first = api.contracts.saveDraft("c1", draft);
    const second = api.contracts.saveDraft("c1", {
      ...draft,
      title: "Lease v2",
    });
    const read = api.contracts.get("c1");
    await Bun.sleep(5);
    expect(log).toEqual(["start PUT"]);
    releaseFirst();
    await Promise.all([first, second, read]);
    expect(log).toEqual([
      "start PUT",
      "end 1",
      "start PUT",
      "end 2",
      "start GET",
      "end 3",
    ]);
  });
});
