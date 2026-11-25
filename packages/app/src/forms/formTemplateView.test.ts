import { describe, expect, it } from "bun:test";
import {
  defaultFormTemplateView,
  readFormTemplateView,
  storeFormTemplateView,
} from "./formTemplateView";

describe("form template view", () => {
  it("defaults to the list when nothing usable is stored", () => {
    expect(defaultFormTemplateView).toBe("list");
    expect(readFormTemplateView({ getItem: () => null })).toBe("list");
    expect(readFormTemplateView({ getItem: () => "table" })).toBe("list");
    expect(
      readFormTemplateView({
        getItem: () => {
          throw new Error("Storage is disabled.");
        },
      }),
    ).toBe("list");
  });

  it("loads and stores the chosen view", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    storeFormTemplateView("grid", storage);
    expect([...values.values()]).toEqual(["grid"]);
    expect(readFormTemplateView(storage)).toBe("grid");
    storeFormTemplateView("list", storage);
    expect(readFormTemplateView(storage)).toBe("list");
  });

  it("ignores storage that refuses writes", () => {
    expect(() =>
      storeFormTemplateView("list", {
        setItem: () => {
          throw new Error("Quota exceeded.");
        },
      }),
    ).not.toThrow();
  });
});
