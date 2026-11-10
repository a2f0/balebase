import { describe, expect, it } from "bun:test";
import { act, useState } from "react";
import { installDom } from "../testing/dom";
import type { OfflineAudit } from "./offlineStore";
import {
  type Edit,
  type OfflineAnswerStorage,
  useOfflineAnswers,
} from "./useOfflineAnswers";

const { mount, settle } = installDom({
  url: "http://localhost:5173/offline",
});

const audit = {
  id: "audit-1",
  local: {},
  sending: [],
  server: { answers: {}, revision: 0, status: "in_progress" },
} as unknown as OfflineAudit;

let latest: ReturnType<typeof useOfflineAnswers> | undefined;
let storage: OfflineAnswerStorage | undefined;
/** Shows the editor another copy of the audit, as a sync would. */
let show: ((next: OfflineAudit) => void) | undefined;

function Harness() {
  const [shown, setShown] = useState(audit);
  show = setShown;
  if (!storage) throw new Error("No storage");
  latest = useOfflineAnswers(shown, "device", storage);
  return null;
}

/** Storage that fails the answer writes, and the completion, it is told to. */
async function mountAnswers(failures: Error[], queueFailure?: Error) {
  const queued: string[] = [];
  const written: Edit[] = [];
  storage = {
    completeAudit: async (_key, id) => {
      if (queueFailure) throw queueFailure;
      queued.push(id);
    },
    saveAnswer: async (_key, _id, _itemId, edit) => {
      written.push(edit);
      const failure = failures.shift();
      if (failure) throw failure;
    },
    saveProgress: async () => {},
  };
  await mount(<Harness />);
  const answers = () => {
    if (!latest) throw new Error("Not mounted");
    return latest;
  };
  return { answers, queued, written };
}

async function answer(
  answers: () => ReturnType<typeof useOfflineAnswers>,
  itemId: string,
  value: string,
) {
  await act(async () => {
    await answers().answer(itemId, value);
  });
  await settle();
}

describe("offline audit answers", () => {
  it("retries an answer with the time and base it was given with", async () => {
    // The first write and its retry both fail, so the answer stays unwritten.
    const { answers, written } = await mountAnswers([
      new Error("Storage full."),
      new Error("Storage full."),
    ]);
    await answer(answers, "exit", "fail");
    // A sync shows a server answer the person never saw before answering.
    await act(async () =>
      show?.({
        ...audit,
        server: {
          answers: {
            exit: {
              at: "2026-11-10T12:09:00.000Z",
              value: "na",
              version: "online-save",
            },
          },
          revision: 2,
          status: "in_progress",
        },
      }),
    );
    await act(async () => {
      await answers().save();
    });
    // Answering again before the first is written keeps its null base.
    await answer(answers, "exit", "pass");
    const [first, retried, again] = written;
    expect(retried).toBe(first);
    expect(first?.base).toBeNull();
    expect(again).toMatchObject({ base: null, value: "pass" });
  });

  it("bases answers to items named like inherited members on what was shown", async () => {
    const { answers, written } = await mountAnswers([]);
    await answer(answers, "constructor", "Rail");
    await answer(answers, "toString", "Fixed");
    expect(written).toEqual([
      { at: expect.any(String), base: null, value: "Rail" },
      { at: expect.any(String), base: null, value: "Fixed" },
    ]);
    expect(answers().error).toBeUndefined();
  });

  it("clears a failed answer's error once it saves", async () => {
    const { answers } = await mountAnswers([new Error("Storage full.")]);
    await answer(answers, "exit", "fail");
    expect(answers().error).toBe("Storage full.");
    await answer(answers, "exit", "pass");
    expect(answers().error).toBeUndefined();
  });

  it("keeps the error while another answer is still unsaved", async () => {
    const { answers } = await mountAnswers([new Error("Storage full.")]);
    await answer(answers, "exit", "fail");
    await answer(answers, "alarm", "pass");
    expect(answers().error).toBe("Storage full.");
  });

  it("keeps a failed completion's error after an answer saves", async () => {
    const { answers } = await mountAnswers([], new Error("Queue unavailable."));
    await act(async () => {
      await answers().save("completion");
    });
    expect(answers().error).toBe("Queue unavailable.");
    await answer(answers, "exit", "pass");
    expect(answers().error).toBe("Queue unavailable.");
  });

  it("shows an answer that will not save over a failed completion", async () => {
    const { answers } = await mountAnswers(
      [new Error("Storage full.")],
      new Error("Queue unavailable."),
    );
    // The completion writes nothing, so the failing write is the answer's.
    await act(async () => {
      await answers().save("completion");
    });
    expect(answers().error).toBe("Queue unavailable.");
    await answer(answers, "exit", "fail");
    expect(answers().error).toBe("Storage full.");
    await answer(answers, "exit", "pass");
    expect(answers().error).toBe("Queue unavailable.");
  });

  it("clears a retried save's failed write once every answer saves", async () => {
    const { answers } = await mountAnswers([
      new Error("Storage full."),
      new Error("Storage full."),
    ]);
    await answer(answers, "exit", "fail");
    // Retrying the draft fails to write it again.
    await act(async () => {
      await answers().save();
    });
    expect(answers().error).toBe("Storage full.");
    await answer(answers, "exit", "pass");
    expect(answers().error).toBeUndefined();
  });

  it("shows the completion's error once retried writes succeed", async () => {
    const { answers } = await mountAnswers(
      [new Error("Storage full.")],
      new Error("Required answers are missing."),
    );
    await answer(answers, "exit", "fail");
    await act(async () => {
      await answers().save("completion");
    });
    expect(answers().error).toBe("Required answers are missing.");
  });
});
