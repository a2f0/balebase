import { describe, expect, it } from "bun:test";
import {
  readHideEmptyCategories,
  storeHideEmptyCategories,
  visibleCategories,
} from "./emptyCategories";

const category = (name: string, transactionCount: number) => ({
  id: name,
  name,
  slug: name.toLowerCase(),
  transactionCount,
});

describe("empty categories", () => {
  it("shows every category until asked to hide empty ones", () => {
    const categories = [category("Meals", 2), category("Travel", 0)];
    expect(visibleCategories(categories, false)).toEqual({
      hidden: 0,
      shown: categories,
    });
    expect(visibleCategories(categories, true)).toEqual({
      hidden: 1,
      shown: [category("Meals", 2)],
    });
  });

  it("loads and stores the choice, defaulting to showing everything", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readHideEmptyCategories(storage)).toBe(false);
    storeHideEmptyCategories(true, storage);
    expect(readHideEmptyCategories(storage)).toBe(true);
    storeHideEmptyCategories(false, storage);
    expect(readHideEmptyCategories(storage)).toBe(false);
  });

  it("tolerates storage that refuses reads and writes", () => {
    const refuse = () => {
      throw new Error("Storage is disabled.");
    };
    expect(readHideEmptyCategories({ getItem: refuse })).toBe(false);
    expect(() =>
      storeHideEmptyCategories(true, { setItem: refuse }),
    ).not.toThrow();
  });
});
