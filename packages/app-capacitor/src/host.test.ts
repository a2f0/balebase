import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  spyOn,
} from "bun:test";
import { Capacitor } from "@capacitor/core";
import { capacitorHost } from "./host";
import { saveNativeFile } from "./saveFile";
import { chooseNativeSavedSignIn } from "./savePassword";

let native: Mock<typeof Capacitor.isNativePlatform>;
let platform: Mock<typeof Capacitor.getPlatform>;

beforeEach(() => {
  native = spyOn(Capacitor, "isNativePlatform");
  platform = spyOn(Capacitor, "getPlatform");
});

afterEach(() => {
  native.mockRestore();
  platform.mockRestore();
});

describe("Capacitor host", () => {
  it("stays a web host outside a device", () => {
    native.mockReturnValue(false);
    expect(capacitorHost("https://app.test")).toEqual({});
  });

  it("names each platform's WebView origin and the hosted app", () => {
    native.mockReturnValue(true);
    const origins = ["ios", "android"].map((os) => {
      platform.mockReturnValue(os);
      const host = capacitorHost("https://app.test").native;
      expect(host?.appUrl).toBe("https://app.test");
      expect(host?.saveFile).toBe(saveNativeFile);
      expect(host?.savePassword).toBeFunction();
      // iOS keyboard AutoFill offers saved passwords; Android's WebView does not.
      expect(host?.chooseSavedSignIn).toBe(
        os === "android" ? chooseNativeSavedSignIn : undefined,
      );
      return host?.origin;
    });
    expect(capacitorHost("https://app.test").network?.getOnline()).toBe(true);
    expect(origins).toEqual(["capacitor://localhost", "https://localhost"]);
  });
});
