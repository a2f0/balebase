import type { CriterionResult } from "./types";

/** Scope calls exhausted grading "finished" and reserves "failed" for execution errors. */
export function isCompleted(status: string, outcome?: string): boolean {
  if (["failed", "cancelled"].includes(status))
    throw new Error(`Run ${status}`);
  if (status !== "done") return false;
  if (outcome !== "succeeded" && outcome !== "finished") {
    throw new Error(`Infrastructure failure: ${outcome ?? "missing outcome"}`);
  }
  return true;
}
export function validateScores(results: CriterionResult[], expected: string[]) {
  const ids = new Set(results.map((result) => result.criterionId));
  if (
    ids.size !== results.length ||
    ids.size !== expected.length ||
    expected.some((id) => !ids.has(id))
  )
    throw new Error("Missing or ambiguous scores");
}
