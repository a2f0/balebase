import { afterEach, beforeEach, expect, it, type Mock, spyOn } from "bun:test";
import type { BackButtonListenerEvent } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { handleBackButton } from "./backButton";

let platform: Mock<typeof Capacitor.getPlatform>;

beforeEach(() => {
  platform = spyOn(Capacitor, "getPlatform");
});

afterEach(() => {
  platform.mockRestore();
});

function start(name: string) {
  platform.mockReturnValue(name);
  const calls: string[] = [];
  let listener: ((event: BackButtonListenerEvent) => void) | undefined;
  handleBackButton(
    {
      addListener: async (eventName, callback) => {
        calls.push(`listen:${eventName}`);
        listener = callback;
      },
      minimizeApp: async () => {
        calls.push("minimize");
      },
    },
    { back: () => calls.push("back") },
  );
  return {
    calls,
    press: (canGoBack: boolean) => listener?.({ canGoBack }),
  };
}

it("steps back through history, then moves the app to the background", () => {
  const { calls, press } = start("android");
  press(true);
  press(false);
  expect(calls).toEqual(["listen:backButton", "back", "minimize"]);
});

it("leaves iOS and the browser alone", () => {
  for (const name of ["ios", "web"]) {
    expect(start(name).calls).toEqual([]);
  }
});
