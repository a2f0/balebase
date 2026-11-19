import { expect, it } from "bun:test";
import { clipboardTransition } from "./clipboardState";

const notice = { message: "Copied.", tone: "success" } as const;
const copying = { status: "copying", request: 2 } as const;
const finished = { status: "finished", notice } as const;

it.each([
  [{ status: "idle" }, { type: "copy", request: 2 }, copying],
  [finished, { type: "copy", request: 2 }, copying],
  [copying, { type: "settled", request: 1, notice }, copying],
  [copying, { type: "settled", request: 2, notice }, finished],
  [finished, { type: "settled", request: 1, notice }, finished],
] as const)("clipboard transition %#", (state, event, expected) => {
  expect(clipboardTransition(state, event)).toEqual(expected);
});
