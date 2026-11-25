import { describe, expect, it } from "bun:test";
import {
  defaultFormTemplateView,
  readFormTemplateView,
  storeFormTemplateView,
} from "./formTemplateView";

describe("form template view", () => {
  it("defaults to the grid when nothing usable is stored", () => {
    expect(defaultFormTemplateView).toBe("grid");
    expect(readFormTemplateView({ getItem: () => null })).toBe("grid");
    expect(readFormTemplateView({ getItem: () => "table" })).toBe("grid");
    expect(
      readFormTemplateView({
        getItem: () => {
          throw new Error("Storage is disabled.");
        },
      }),
    ).toBe("grid");
  });

  it("loads and stores the chosen view", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    storeFormTemplateView("list", storage);
    expect([...values.values()]).toEqual(["list"]);
    expect(readFormTemplateView(storage)).toBe("list");
    storeFormTemplateView("grid", storage);
    expect(readFormTemplateView(storage)).toBe("grid");
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
