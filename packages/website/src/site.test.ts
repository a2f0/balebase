/// <reference types="bun" />
import { expect, test } from "bun:test";
import { storeBadgeHref, storeListings } from "./site";

const [appStore, googlePlay] = storeListings;
if (!appStore || !googlePlay) throw new Error("Both store listings exist.");
const listed = { ...appStore, listed: true };

test("a store badge links to its listing only once the store lists the app", () => {
  expect(storeBadgeHref({ ...appStore, listed: false })).toBeNull();
  expect(storeBadgeHref(listed)).toBe(
    "https://apps.apple.com/app/id6825740983",
  );
  expect(storeBadgeHref({ ...googlePlay, listed: true })).toBe(
    "https://play.google.com/store/apps/details?id=com.balebase.app",
  );
});
