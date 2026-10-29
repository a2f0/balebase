import { expect, test } from "bun:test";
import {
  countLabel,
  formatBytes,
  formatCalendarDate,
  formatDate,
  formatDateTime,
  formatLabel,
  formatShortDate,
} from "./labels";

/** Runs `check` with the process in each time zone, then restores it. */
function inTimeZones(zones: string[], check: (zone: string) => void) {
  const saved = process.env.TZ;
  try {
    for (const zone of zones) {
      process.env.TZ = zone;
      check(zone);
    }
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env.TZ = saved;
  }
}

function inZone(zone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: zone });
}

test("countLabel pluralizes regular and irregular nouns", () => {
  expect(countLabel(0, "audit")).toBe("0 audits");
  expect(countLabel(1, "audit")).toBe("1 audit");
  expect(countLabel(2, "audit")).toBe("2 audits");
  expect(countLabel(1, "business", "businesses")).toBe("1 business");
  expect(countLabel(3, "business", "businesses")).toBe("3 businesses");
});

test("formatLabel turns machine values into sentence case", () => {
  expect(formatLabel("in_progress")).toBe("In progress");
  expect(formatLabel("past_due")).toBe("Past due");
  expect(formatLabel("high")).toBe("High");
  expect(formatLabel("FOOD_AND_DRINK")).toBe("Food and drink");
  expect(formatLabel("")).toBe("");
});

test("formatBytes uses the largest sensible unit", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(3_500)).toBe("3.4 KB");
  expect(formatBytes(12 * 1024 * 1024)).toBe("12.0 MB");
});

test("formatCalendarDate shows the same day in every time zone", () => {
  // Samoa skipped December 30, 2011, so its local noon fell on the 31st.
  const days = ["2026-03-01", "2026-12-31", "2011-12-30"];
  const expected = days.map((day) =>
    inZone("UTC", { dateStyle: "medium" }).format(new Date(`${day}T00:00Z`)),
  );
  inTimeZones(
    ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Pacific/Apia", "UTC"],
    () => {
      expect(days.map((day) => formatCalendarDate(day))).toEqual(expected);
    },
  );
  inTimeZones(["America/Los_Angeles"], () => {
    expect(
      formatCalendarDate("2026-03-01", { day: "numeric", month: "short" }),
    ).toBe(
      inZone("UTC", { day: "numeric", month: "short" }).format(
        new Date("2026-03-01T00:00Z"),
      ),
    );
  });
});

test("formatCalendarDate leaves unexpected values visible", () => {
  expect(formatCalendarDate("unknown")).toBe("unknown");
  expect(formatCalendarDate("2026-03-01T10:00:00Z")).toBe(
    "2026-03-01T10:00:00Z",
  );
});

test("moment formatters use the viewer's time zone", () => {
  const moment = "2026-03-01T03:30:00Z";
  inTimeZones(["America/Los_Angeles", "Asia/Tokyo"], (zone) => {
    expect(formatDate(moment)).toBe(
      inZone(zone, { dateStyle: "medium" }).format(new Date(moment)),
    );
    expect(formatDate(new Date(moment))).toBe(formatDate(moment));
    expect(formatDateTime(moment)).toBe(
      inZone(zone, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(moment),
      ),
    );
    expect(formatShortDate(moment)).toBe(
      inZone(zone, { day: "numeric", month: "short" }).format(new Date(moment)),
    );
  });
  inTimeZones(["America/Los_Angeles"], () => {
    expect(formatDate(moment)).not.toBe(formatCalendarDate("2026-03-01"));
  });
});
