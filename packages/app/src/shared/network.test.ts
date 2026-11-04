import { afterEach, expect, it } from "bun:test";
import { configureHost } from "../host";
import { isOnline, onNetworkChange } from "./network";

afterEach(() => configureHost({}));

it("uses the shell's connectivity over the browser's when it has one", () => {
  let listener: ((online: boolean) => void) | undefined;
  configureHost({
    network: {
      getOnline: () => false,
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  });
  expect(isOnline()).toBe(false);
  const seen: boolean[] = [];
  const stop = onNetworkChange((online) => seen.push(online));
  listener?.(true);
  stop();
  expect(seen).toEqual([true]);
  expect(listener).toBeUndefined();
});
