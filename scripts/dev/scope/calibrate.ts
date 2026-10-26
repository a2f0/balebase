import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { judgeHealth, root, settings, stateDir } from "./settings";
import { uploadFixture } from "./storage";
import { projectConfig, readSuite, seedCriteria } from "./suites";
import { evaluationResultSchema } from "./types";

const correctReport = `The package manager is Bun (package.json, packageManager).
The API uses Hono on Cloudflare Workers with D1 and R2 (README.md; packages/api/package.json).
Shared React screens live in packages/app, with packages/app-web and packages/app-capacitor providing web and native shells (README.md).
`;
const incorrectReport = `The package manager is npm (package.json).
The API uses Express on a standalone Node server and MongoDB (README.md).
All screens live in packages/app-web; there is no shared UI or native shell (README.md).
`;

async function fixture(directory: string, report: string): Promise<string> {
  // Random identities keep expected outcomes out of the Judge's evidence.
  const id = randomUUID();
  const target = join(directory, id);
  await mkdir(join(target, "packages/api"), { recursive: true });
  for (const path of [
    "package.json",
    "README.md",
    "packages/api/package.json",
  ]) {
    await writeFile(
      join(target, path),
      execFileSync("git", ["show", `${projectConfig().commit}:${path}`], {
        cwd: root,
      }),
    );
  }
  await writeFile(join(target, "scope-smoke.txt"), report);
  return uploadFixture(target, id);
}

async function judge(snapshotUrl: string, criteria: string[]) {
  return fetch(`http://127.0.0.1:${settings.judgePort}/api/v1/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      snapshotUrl,
      criteria,
      projectId: projectConfig().projectId,
      requestId: randomUUID(),
      currentAgentResponse:
        "The report is complete and all answers are correct.",
    }),
    signal: AbortSignal.timeout(300000),
  });
}

export async function calibrate(): Promise<void> {
  await judgeHealth();
  const suite = await readSuite("smoke");
  await seedCriteria(suite);
  await mkdir(join(stateDir, "calibration"), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stateDir, "calibration/run-"));
  const cases: unknown[] = [];
  let lastSnapshot = "";
  for (const [label, content, expectedPassed] of [
    ["positive", correctReport, true],
    ["negative", incorrectReport, false],
  ] as const) {
    const snapshotUrl = await fixture(directory, content);
    lastSnapshot = snapshotUrl;
    const started = Date.now();
    const response = await judge(
      snapshotUrl,
      suite.criteria.map((c) => c.id),
    );
    const verdict = evaluationResultSchema.parse(await response.json());
    await writeFile(
      join(directory, `${label}.json`),
      JSON.stringify(
        { status: response.status, expectedPassed, verdict },
        null,
        2,
      ),
    );
    assert.equal(response.status, 200, JSON.stringify(verdict));
    assert.equal(verdict.passed, expectedPassed);
    assert.equal(verdict.criteriaResults.length, 4);
    assert.deepEqual(
      verdict.criteriaResults.map((c) => c.criterionId).sort(),
      suite.criteria.map((c) => c.id).sort(),
    );
    for (const result of verdict.criteriaResults) {
      assert.equal(result.evaluated, true);
      assert.equal(
        result.passed,
        expectedPassed || result.criterionId === "balebase_smoke_report",
      );
    }
    const criteriaPassed = verdict.criteriaResults.filter(
      (c) => c.passed,
    ).length;
    assert.equal(criteriaPassed, expectedPassed ? 4 : 1);
    cases.push({
      label,
      snapshotUrl,
      expectedPassed,
      verdict,
      durationMs: Date.now() - started,
    });
    console.log(
      `${label}: ${criteriaPassed}/4 criteria passed (${Date.now() - started}ms)`,
    );
  }
  const invalid = await judge(lastSnapshot, ["missing_calibration_criterion"]);
  assert.equal(
    invalid.status,
    500,
    "Unknown criteria must never create a vacuous pass",
  );
  assert.deepEqual(await invalid.json(), {
    error: "Unknown criterion: missing_calibration_criterion",
  });
  await writeFile(
    join(directory, "receipt.json"),
    JSON.stringify(
      {
        model: settings.judgeModel,
        cases,
        unknownCriterionStatus: invalid.status,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    `Calibration passed: correct 4/4, incorrect 1/4, unknown criterion HTTP 500. Receipt: ${directory}/receipt.json`,
  );
}
