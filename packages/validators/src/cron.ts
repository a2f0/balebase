// Five-field cron schedules in UTC, as root admins set them for maintenance
// jobs. Plain values and functions, so the app can describe a schedule
// without pulling in zod.

/** The longest schedule an admin can save. */
export const cronExpressionMaxLength = 100;

export interface CronSchedule {
  /** The expression with single spaces between its five fields. */
  expression: string;
  minutes: readonly number[];
  hours: readonly number[];
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Whether the day-of-month and day-of-week fields narrow the days. */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const monthNames = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const weekdayLabels = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

interface FieldRange {
  min: number;
  max: number;
  /** Names accepted for values, counted from `min`. */
  names?: readonly string[];
}

const minuteRange: FieldRange = { min: 0, max: 59 };
const hourRange: FieldRange = { min: 0, max: 23 };
const dayRange: FieldRange = { min: 1, max: 31 };
const monthRange: FieldRange = { min: 1, max: 12, names: monthNames };
// Both 0 and 7 are Sunday.
const weekdayRange: FieldRange = { min: 0, max: 7, names: weekdayNames };

/** The expression with its fields separated by single spaces. */
export function normalizeCron(expression: string) {
  return expression.trim().split(/\s+/).join(" ");
}

/** The schedule an expression describes, or null when it is not valid. */
export function parseCron(expression: string): CronSchedule | null {
  if (expression.length > cronExpressionMaxLength) return null;
  const normalized = normalizeCron(expression);
  const fields = normalized.split(" ");
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseField(minute, minuteRange);
  const hours = parseField(hour, hourRange);
  const days = parseField(day, dayRange);
  const months = parseField(month, monthRange);
  const weekdays = parseField(weekday, weekdayRange);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return {
    expression: normalized,
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    days,
    months,
    weekdays: new Set([...weekdays].map((value) => value % 7)),
    daysRestricted: !day.startsWith("*"),
    weekdaysRestricted: !weekday.startsWith("*"),
  };
}

function parseField(field: string, range: FieldRange) {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const span = parsePart(part, range);
    if (!span) return null;
    for (let value = span.start; value <= span.end; value += span.step)
      values.add(value);
  }
  return values.size ? values : null;
}

/** One list item: `*`, a value, or a range, with an optional `/step`. */
function parsePart(part: string, range: FieldRange) {
  const match = /^([^/]+)(?:\/(\d+))?$/.exec(part);
  if (!match?.[1]) return null;
  const stepped = match[2] !== undefined;
  const step = stepped ? Number(match[2]) : 1;
  if (!Number.isInteger(step) || step < 1) return null;
  if (match[1] === "*") return { start: range.min, end: range.max, step };
  const [first, last, ...extra] = match[1].split("-");
  if (extra.length) return null;
  const start = fieldValue(first, range);
  if (start === null) return null;
  // A lone value with a step, such as 5/15, runs to the field's end.
  const end =
    last !== undefined ? fieldValue(last, range) : stepped ? range.max : start;
  if (end === null || end < start) return null;
  return { start, end, step };
}

function fieldValue(text: string | undefined, range: FieldRange) {
  if (!text) return null;
  const named = range.names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) return named + range.min;
  if (!/^\d{1,2}$/.test(text)) return null;
  const value = Number(text);
  return value >= range.min && value <= range.max ? value : null;
}

/** Whether a UTC calendar day is one the schedule runs on. */
function dayMatches(schedule: CronSchedule, date: Date) {
  if (!schedule.months.has(date.getUTCMonth() + 1)) return false;
  const day = schedule.days.has(date.getUTCDate());
  const weekday = schedule.weekdays.has(date.getUTCDay());
  // As in cron, a day matches either restricted field when both are set.
  if (schedule.daysRestricted && schedule.weekdaysRestricted)
    return day || weekday;
  return day && weekday;
}

/** Whether the schedule runs in the UTC minute that contains `time`. */
export function cronMatches(schedule: CronSchedule, time: Date) {
  return (
    dayMatches(schedule, time) &&
    schedule.hours.includes(time.getUTCHours()) &&
    schedule.minutes.includes(time.getUTCMinutes())
  );
}

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
// Long enough to reach the next 29 February.
const searchDays = 366 * 8;

/** The first minute after `after` that the schedule runs in, or null for never. */
export function nextCronRun(schedule: CronSchedule, after: Date) {
  const start = new Date(
    Math.floor(after.getTime() / minuteMs) * minuteMs + minuteMs,
  );
  const firstDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  for (let index = 0; index < searchDays; index++) {
    const day = firstDay + index * dayMs;
    if (!dayMatches(schedule, new Date(day))) continue;
    for (const hour of schedule.hours) {
      if (index === 0 && hour < start.getUTCHours()) continue;
      for (const minute of schedule.minutes) {
        if (
          index === 0 &&
          hour === start.getUTCHours() &&
          minute < start.getUTCMinutes()
        )
          continue;
        return new Date(day + hour * 60 * minuteMs + minute * minuteMs);
      }
    }
  }
  return null;
}

/** Why an expression cannot be saved as a schedule, or null when it can. */
export function cronProblem(expression: string, now = new Date()) {
  const schedule = parseCron(expression);
  if (!schedule)
    return "Enter five cron fields in UTC: minute, hour, day of month, month, and day of week.";
  if (!nextCronRun(schedule, now)) return "This schedule never runs.";
  return null;
}

/** A sentence for the schedule, such as "Every day at 03:00 UTC". */
export function describeCron(expression: string) {
  const schedule = parseCron(expression);
  if (!schedule) return `Cron schedule ${expression} (UTC)`;
  const [minute = "", hour = "", day = "", month = "", weekday = ""] =
    schedule.expression.split(" ");
  const fields = { minute, hour, day, month, weekday };
  return (
    (day === "*" && month === "*" && weekday === "*" && hour === "*"
      ? describeWithinHour(schedule, fields)
      : null) ??
    (single(minute) && single(hour) && month === "*"
      ? describeAtTime(schedule, fields)
      : null) ??
    `Cron schedule ${schedule.expression} (UTC)`
  );
}

interface CronFields {
  minute: string;
  hour: string;
  day: string;
  month: string;
  weekday: string;
}

/** A field that names exactly one value. */
function single(field: string) {
  return !/[*/,-]/.test(field);
}

/** Schedules that run every hour of every day. */
function describeWithinHour(schedule: CronSchedule, { minute }: CronFields) {
  if (minute === "*") return "Every minute";
  const step = /^\*\/(\d+)$/.exec(minute)?.[1];
  if (step) return `Every ${step} minutes (UTC)`;
  if (!single(minute)) return null;
  const past = schedule.minutes[0] ?? 0;
  if (past === 0) return "Every hour on the hour (UTC)";
  return `Every hour at ${past} ${past === 1 ? "minute" : "minutes"} past the hour (UTC)`;
}

/** Schedules that run once at one time of day on the days they name. */
function describeAtTime(schedule: CronSchedule, { day, weekday }: CronFields) {
  const at = `${pad(schedule.hours[0])}:${pad(schedule.minutes[0])} UTC`;
  if (day === "*" && weekday === "*") return `Every day at ${at}`;
  if (day === "*") {
    const names = [...schedule.weekdays]
      .sort((a, b) => a - b)
      .map((value) => weekdayLabels[value]);
    return `Every ${listLabel(names)} at ${at}`;
  }
  if (weekday === "*" && single(day))
    return `Monthly on day ${[...schedule.days][0]} at ${at}`;
  return null;
}

function pad(value: number | undefined) {
  return String(value ?? 0).padStart(2, "0");
}

function listLabel(values: readonly (string | undefined)[]) {
  const names = values.filter((value) => value !== undefined);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}
