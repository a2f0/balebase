import { expect, test } from "bun:test";
import { childEnvironment } from "../../dev/scope/judge/codex";
import {
  checkGate,
  loadCriteria,
  orderCriteria,
} from "../../dev/scope/judge/criteria";
import { loopbackOrigin } from "../../dev/scope/settings";
import { readSuite, validateSuite } from "../../dev/scope/suites";
import type { Criterion } from "../../dev/scope/types";

const parent: Criterion = {
  id: "parent",
  prompt: "Parent",
  dependsOn: [],
  gates: ["select"],
};
const child: Criterion = {
  id: "child",
  prompt: "Child",
  dependsOn: ["parent"],
  gates: [],
};

test("API origins accept loopback only, without credentials or URL suffixes", () => {
  for (const value of [
    "http://localhost:3100",
    "https://127.0.0.1:3100/",
    "http://[::1]:3100",
  ])
    expect(loopbackOrigin(value)).toBe(new URL(value).origin);
  for (const value of [
    "http://example.com",
    "http://127.0.0.1.example.com",
    "file:///tmp/api",
    "http://user:secret@localhost",
    "http://localhost/api",
    "http://localhost?token=x",
    "http://localhost#fragment",
  ])
    expect(() => loopbackOrigin(value)).toThrow();
});

test("judge inherits CLI necessities but no provider keys or repository credentials", () => {
  const source = {
    HOME: "/fixture",
    PATH: "/fixture/bin",
    CODEX_HOME: "/fixture/codex",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    SCOPE_TOKEN: "secret",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
  };
  expect(childEnvironment(source)).toEqual({
    HOME: "/fixture",
    PATH: "/fixture/bin",
    CODEX_HOME: "/fixture/codex",
  });
  expect(source.OPENAI_API_KEY).toBe("secret");
});

test("criterion lookup is project-scoped and closes dependencies", async () => {
  const paths: string[] = [];
  const result = await loadCriteria(["child"], "project/id", async (path) => {
    paths.push(path);
    return [child, parent];
  });
  expect(paths).toEqual(["/criteria?projectId=project%2Fid"]);
  expect(result).toEqual([parent, child]);
});

test("criterion lookup rejects unknown, missing, duplicate and cyclic definitions", async () => {
  const request = async () => [parent, child];
  await expect(loadCriteria([], "p", request)).rejects.toThrow(
    "Empty or duplicate",
  );
  await expect(loadCriteria(["child", "child"], "p", request)).rejects.toThrow(
    "Empty or duplicate",
  );
  await expect(loadCriteria(["unknown"], "p", request)).rejects.toThrow(
    "Unknown criterion",
  );
  await expect(
    loadCriteria(["child"], "p", async () => [child]),
  ).rejects.toThrow("Unknown criterion");
  await expect(
    loadCriteria(["parent"], "p", async () => [parent, parent]),
  ).rejects.toThrow("Duplicate criterion");
  expect(() => orderCriteria([child])).toThrow("Missing prerequisite");
  expect(() =>
    orderCriteria([child, { ...parent, dependsOn: ["child"] }]),
  ).toThrow("Cycle");
});

test("incompatible gates fail before grading", () => {
  expect(() => checkGate([parent, child], "select")).not.toThrow();
  expect(() => checkGate([parent], "test")).toThrow("incompatible with test");
  expect(() => checkGate([child], "test")).not.toThrow();
});

test("suite validation rejects ambiguous tasks and criterion references", async () => {
  const suite = {
    id: "fixture",
    description: "fixture",
    criteria: [parent, child],
    tasks: [{ id: "task", prompt: "Inspect", criteria: ["child"] }],
  };
  expect(validateSuite(suite)).toEqual(suite);
  expect(() =>
    validateSuite({ ...suite, tasks: [...suite.tasks, ...suite.tasks] }),
  ).toThrow("Duplicate task");
  for (const criteria of [["missing"], ["child", "child"]])
    expect(() =>
      validateSuite({ ...suite, tasks: [{ ...suite.tasks[0], criteria }] }),
    ).toThrow("Invalid task criteria");
  expect(() => validateSuite({ ...suite, criteria: [child] })).toThrow(
    "Missing prerequisite",
  );
  expect((await readSuite("smoke")).tasks).toHaveLength(1);
  expect((await readSuite("agent-friendliness")).tasks).toHaveLength(3);
});
