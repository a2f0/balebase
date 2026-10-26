import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForRun } from "../../dev/scope/benchmark";

const entry = {
  id: "request",
  task: "fixture",
  url: "http://localhost/runs/request",
};

test("polling persists queued/running/completed evidence and returns completed scores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-poll-test-"));
  const file = join(directory, "run.json");
  const responses = [
    { id: entry.id, run: { status: "queued" } },
    { id: entry.id, run: { status: "running" } },
    {
      id: entry.id,
      run: {
        status: "done",
        outcome: "finished",
        turns: [
          {
            criteriaResults: [
              {
                criterionId: "rule",
                passed: false,
                evaluated: true,
                feedback: "missing evidence",
              },
            ],
          },
        ],
      },
    },
  ];
  const slept: number[] = [];
  let index = 0;
  const completed = responses[2];
  if (!completed) throw new Error("Missing completion fixture");
  try {
    const result = await waitForRun(entry, file, {
      request: async (path) => {
        expect(path).toBe("/requests/request");
        return responses[index++];
      },
      now: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
        expect(await Bun.file(file).json()).toEqual(responses[index - 1]);
      },
    });
    expect(result).toEqual(completed);
    expect(await Bun.file(file).json()).toEqual(responses[2]);
    expect(slept).toEqual([5000, 5000]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("polling preserves terminal failures and times out active runs without resubmission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-poll-test-"));
  const file = join(directory, "run.json");
  try {
    for (const run of [
      { status: "failed" },
      { status: "cancelled" },
      { status: "done", outcome: "failed" },
    ]) {
      const raw = { id: entry.id, run };
      await expect(
        waitForRun(entry, file, { request: async () => raw }),
      ).rejects.toThrow();
      expect(await Bun.file(file).json()).toEqual(raw);
    }
    let time = 0;
    let calls = 0;
    const raw = { id: entry.id, run: { status: "running" } };
    await expect(
      waitForRun(entry, file, {
        timeoutMs: 5,
        now: () => time,
        sleep: async () => {
          time = 5;
        },
        request: async (_path, body) => {
          calls++;
          expect(body).toBeUndefined();
          return raw;
        },
      }),
    ).rejects.toThrow(
      `Timed out; run is still active at ${entry.url}. Inspect before resubmitting.`,
    );
    expect(calls).toBe(2);
    expect(await Bun.file(file).json()).toEqual(raw);
    await expect(
      waitForRun(entry, file, {
        request: async () => ({ id: entry.id, run: { status: 42 } }),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assessment CLI rejects invalid counts and extra/missing arguments before using services", () => {
  const script = resolve(import.meta.dir, "../../dev/scope.ts");
  const cases: [string[], string][] = [
    [["register", "a", "b"], "Usage: scope register"],
    [["calibrate", "extra"], "Usage: scope calibrate"],
    [["smoke", "1"], "Usage: scope benchmark"],
    [["benchmark", "1", "extra"], "Usage: scope benchmark"],
    [["regrade"], "Usage: scope regrade"],
    [["regrade", "a", "b"], "Usage: scope regrade"],
    [["judge", "extra"], "Usage: scope judge"],
    [["portal", "extra"], "Usage: scope portal"],
    [["unknown"], "Unknown assessment command"],
    ...["0", "-1", "1.5", "11", "nope"].map((count): [string[], string] => [
      ["benchmark", count],
      "Count must be 1–10",
    ]),
  ];
  for (const [args, error] of cases) {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, SCOPE_API_URL: "http://invalid.example" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(result.stderr).not.toContain("Scope endpoints must be loopback");
  }
});
