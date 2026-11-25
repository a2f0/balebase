import { describe, expect, it } from "bun:test";
import {
  cronMatches,
  cronProblem,
  describeCron,
  nextCronRun,
  normalizeCron,
  parseCron,
} from "./cron";

function next(expression: string, after: string) {
  const schedule = parseCron(expression);
  if (!schedule) throw new Error(`Invalid schedule ${expression}`);
  return nextCronRun(schedule, new Date(after))?.toISOString() ?? null;
}

describe("parseCron", () => {
  it("accepts wildcards, values, ranges, steps, lists, and names", () => {
    const schedule = parseCron(" 5/20  1-3,22 */10 JAN-mar mon-FRI ");
    expect(schedule).toMatchObject({
      expression: "5/20 1-3,22 */10 JAN-mar mon-FRI",
      minutes: [5, 25, 45],
      hours: [1, 2, 3, 22],
      daysRestricted: false,
      weekdaysRestricted: true,
    });
    expect([...(schedule?.days ?? [])]).toEqual([1, 11, 21, 31]);
    expect([...(schedule?.months ?? [])]).toEqual([1, 2, 3]);
    expect([...(schedule?.weekdays ?? [])]).toEqual([1, 2, 3, 4, 5]);
    // Both 0 and 7 are Sunday.
    expect([...(parseCron("0 0 * * 5-7")?.weekdays ?? [])]).toEqual([5, 6, 0]);
  });

  it.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "5-1 * * * *",
    "1-2-3 * * * *",
    "a * * * *",
    ", * * * *",
    "1,,2 * * * *",
    "-1 * * * *",
    `${"1,".repeat(60)}1 * * * *`,
  ])("rejects %p", (expression) => {
    expect(parseCron(expression)).toBeNull();
  });
});

describe("nextCronRun", () => {
  it("finds the next minute strictly after the given time", () => {
    expect(next("17 * * * *", "2026-11-25T10:16:59.999Z")).toBe(
      "2026-11-25T10:17:00.000Z",
    );
    expect(next("17 * * * *", "2026-11-25T10:17:00.000Z")).toBe(
      "2026-11-25T11:17:00.000Z",
    );
    expect(next("17 * * * *", "2026-11-25T23:30:00.000Z")).toBe(
      "2026-11-26T00:17:00.000Z",
    );
    expect(next("* * * * *", "2026-11-25T10:16:30.000Z")).toBe(
      "2026-11-25T10:17:00.000Z",
    );
  });

  it("matches either restricted day field, as cron does", () => {
    // 2026-11-25 is a Wednesday; the 1st of December is a Tuesday.
    expect(next("0 3 1 * MON", "2026-11-25T12:00:00.000Z")).toBe(
      "2026-11-30T03:00:00.000Z",
    );
    expect(next("0 3 1 * *", "2026-11-25T12:00:00.000Z")).toBe(
      "2026-12-01T03:00:00.000Z",
    );
    expect(next("0 3 * * TUE", "2026-11-25T12:00:00.000Z")).toBe(
      "2026-12-01T03:00:00.000Z",
    );
  });

  it("reaches the next leap day and reports schedules that never run", () => {
    expect(next("0 0 29 2 *", "2026-11-25T00:00:00.000Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(next("0 0 31 2 *", "2026-11-25T00:00:00.000Z")).toBeNull();
  });
});

describe("cronMatches", () => {
  it("matches the UTC minute regardless of seconds", () => {
    const schedule = parseCron("17 * * * *");
    if (!schedule) throw new Error("Invalid schedule");
    expect(cronMatches(schedule, new Date("2026-11-25T10:17:42.000Z"))).toBe(
      true,
    );
    expect(cronMatches(schedule, new Date("2026-11-25T10:18:00.000Z"))).toBe(
      false,
    );
  });
});

describe("cronProblem", () => {
  it("explains invalid and impossible schedules", () => {
    expect(cronProblem("17 * * * *")).toBeNull();
    expect(cronProblem("every hour")).toContain("five cron fields");
    expect(cronProblem("0 0 30 2 *")).toBe("This schedule never runs.");
  });
});

describe("describeCron", () => {
  it.each([
    ["17 * * * *", "Every hour at 17 minutes past the hour (UTC)"],
    ["1 * * * *", "Every hour at 1 minute past the hour (UTC)"],
    ["0 * * * *", "Every hour on the hour (UTC)"],
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes (UTC)"],
    ["5 3 * * *", "Every day at 03:05 UTC"],
    ["0 9 * * 1", "Every Monday at 09:00 UTC"],
    ["0 9 * * 1,3", "Every Monday and Wednesday at 09:00 UTC"],
    [
      "0 9 * * 1-5",
      "Every Monday, Tuesday, Wednesday, Thursday, and Friday at 09:00 UTC",
    ],
    ["30 2 15 * *", "Monthly on day 15 at 02:30 UTC"],
    ["0 */6 * * *", "Cron schedule 0 */6 * * * (UTC)"],
    ["0 0 1 1 *", "Cron schedule 0 0 1 1 * (UTC)"],
    ["nonsense", "Cron schedule nonsense (UTC)"],
  ])("describes %p", (expression, description) => {
    expect(describeCron(expression)).toBe(description);
  });

  it("normalizes spacing", () => {
    expect(normalizeCron("  0   3 * *\t* ")).toBe("0 3 * * *");
  });
});
