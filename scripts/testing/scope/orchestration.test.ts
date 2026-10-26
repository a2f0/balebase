import { expect, test } from "bun:test";
import { selectCriteria } from "../../dev/scope/judge/criteria";
import {
  inputSchema,
  toolOutputRequests,
} from "../../dev/scope/judge/evaluate";
import { judgeHandler } from "../../dev/scope/judge/http";
import { regradeInput } from "../../dev/scope/regrade";
import { validateScores } from "../../dev/scope/runState";
import { runLogIdentity } from "../../dev/scope/storage";

const input = {
  snapshotUrl:
    "http://azurite:10000/devstoreaccount1/snapshots/request/runs/run/iteration-1/workspace.tar.gz",
  projectId: "00000000-0000-4000-8000-000000000001",
  criteria: ["rule"],
};
const noop = () => {};
const request = (body: unknown = input) =>
  new Request("http://localhost:3202/api/v1/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const health = () => new Request("http://localhost:3202/health");

test("snapshot identity selects only its request/run log and positive iteration", () => {
  expect(
    runLogIdentity("request/runs/run/iteration-2/workspace.tar.gz"),
  ).toEqual({ name: "request/runs/run/run.jsonl", iteration: 2 });
  expect(
    runLogIdentity("request/runs/retry/iteration-1/workspace.tar.gz")?.name,
  ).toBe("request/runs/retry/run.jsonl");
  for (const name of [
    "request/iteration-1/workspace.tar.gz",
    "request/runs/run/iteration-0/workspace.tar.gz",
    "request/runs/run/iteration-1/tool-calls.jsonl",
    "extra/request/runs/run/iteration-1/workspace.tar.gz",
  ])
    expect(runLogIdentity(name)).toBeUndefined();
});

test("tool evidence preserves original turn numbering and current iteration", () => {
  expect(toolOutputRequests(inputSchema.parse(input))).toEqual([]);
  const parsed = inputSchema.parse({
    ...input,
    conversationHistory: [
      {},
      { toolCallsUrl: "http://localhost/previous" },
      { iteration: 7, toolCallsUrl: "http://localhost/seven" },
    ],
    iteration: 8,
    toolCallsUrl: "http://localhost/current",
  });
  expect(toolOutputRequests(parsed)).toEqual([
    { iteration: 2, url: "http://localhost/previous" },
    { iteration: 7, url: "http://localhost/seven" },
    { iteration: 8, url: "http://localhost/current" },
  ]);
  expect(
    toolOutputRequests(
      inputSchema.parse({
        ...input,
        conversationHistory: [{}],
        toolCallsUrl: "http://localhost/current",
      }),
    ),
  ).toEqual([{ iteration: 2, url: "http://localhost/current" }]);
});

test("benchmark requires complete unambiguous scores including dependencies", () => {
  const criteria = [
    { id: "parent", prompt: "Parent", dependsOn: [], gates: [] },
    { id: "child", prompt: "Child", dependsOn: ["parent"], gates: [] },
  ];
  const expected = selectCriteria(criteria, ["child"]).map((c) => c.id);
  const result = (criterionId: string) => ({
    criterionId,
    passed: false,
    evaluated: true,
    feedback: "Observed failure is still a completed score",
  });
  expect(() =>
    validateScores([result("child"), result("parent")], expected),
  ).not.toThrow();
  for (const scores of [
    [],
    [result("child")],
    [result("child"), result("child")],
    [result("child"), result("parent"), result("unknown")],
  ])
    expect(() => validateScores(scores, expected)).toThrow(
      "Missing or ambiguous",
    );
});

test("regrade accepts completed evidence and excludes old verdicts from its payload", () => {
  const turn = {
    iteration: 1,
    snapshotUrl: input.snapshotUrl,
    codingAgentResponse: "Source report",
    toolCallsUrl: "http://localhost/tools",
    judgeFeedback: "OLD GRADE",
    criteriaResults: [{ passed: true }],
  };
  const run = {
    scenario: { criteria: ["rule"] },
    run: { status: "done", outcome: "finished", turns: [turn] },
  };
  expect(regradeInput(run, input.projectId, "request")).toEqual({
    snapshotUrl: input.snapshotUrl,
    toolCallsUrl: turn.toolCallsUrl,
    iteration: 1,
    projectId: input.projectId,
    currentAgentResponse: "Source report",
    criteria: ["rule"],
    requestId: "regrade-request",
  });
  expect(() =>
    regradeInput(
      { ...run, run: { ...run.run, outcome: "failed" } },
      input.projectId,
      "request",
    ),
  ).toThrow("Infrastructure failure");
  expect(() =>
    regradeInput(
      { ...run, run: { ...run.run, turns: [turn, turn] } },
      input.projectId,
      "request",
    ),
  ).toThrow();
});

test("judge HTTP validation rejects invalid input before invoking the evaluator", async () => {
  let calls = 0;
  const handle = judgeHandler({
    port: 3202,
    model: "fixture",
    version: "fixture",
    evaluate: async () => {
      calls++;
      return {};
    },
  });
  expect(
    (await handle(new Request("http://localhost:3202/missing"), noop)).status,
  ).toBe(404);
  expect(
    (await handle(request({ ...input, gate: "unknown" }), noop)).status,
  ).toBe(400);
  expect(
    (
      await handle(
        new Request("http://localhost:3202/api/v1/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
        noop,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handle(
        new Request("http://localhost:3202/api/v1/evaluate", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        }),
        noop,
      )
    ).status,
  ).toBe(403);
  expect(calls).toBe(0);
  expect((await (await handle(health(), noop)).json()).active).toBe(false);
});

test("judge is exclusive while evaluating and releases its slot on completion or error", async () => {
  const pending = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  let timeoutsDisabled = 0;
  const handle = judgeHandler({
    port: 3202,
    model: "fixture",
    version: "fixture",
    evaluate: async () => {
      calls++;
      started.resolve();
      return pending.promise;
    },
  });
  const first = handle(request(), () => {
    timeoutsDisabled++;
  });
  await started.promise;
  expect((await handle(request(), noop)).status).toBe(503);
  expect((await (await handle(health(), noop)).json()).active).toBe(true);
  pending.resolve({ passed: true, criteriaResults: [] });
  expect((await first).status).toBe(200);
  expect(calls).toBe(1);
  expect(timeoutsDisabled).toBe(1);
  expect((await (await handle(health(), noop)).json()).active).toBe(false);
  const failing = judgeHandler({
    port: 3202,
    model: "fixture",
    version: "fixture",
    evaluate: async () => {
      throw new Error("fixture failure");
    },
  });
  expect((await failing(request(), noop)).status).toBe(500);
  expect((await (await failing(health(), noop)).json()).active).toBe(false);
});
