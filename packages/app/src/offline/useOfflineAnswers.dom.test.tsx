import { describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import type { OfflineAudit } from "./offlineStore";
import {
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
  server: { answers: {}, revision: 0 },
} as unknown as OfflineAudit;

let latest: ReturnType<typeof useOfflineAnswers> | undefined;
let storage: OfflineAnswerStorage | undefined;

function Harness() {
  if (!storage) throw new Error("No storage");
  latest = useOfflineAnswers(audit, "device", storage);
  return null;
}

/** Storage that fails the answer writes, and the completion, it is told to. */
async function mountAnswers(failures: Error[], queueFailure?: Error) {
  const queued: string[] = [];
  storage = {
    completeAudit: async (_key, id) => {
      if (queueFailure) throw queueFailure;
      queued.push(id);
    },
    saveAnswer: async () => {
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
  return { answers, queued };
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
