import { expect, it } from "bun:test";
import { withNativeOrigin } from "./nativeRequest";

it.each(["capacitor://localhost", "https://localhost"])(
  "restores %s for native cookie requests without changing the body",
  async (origin) => {
    const request = withNativeOrigin(
      new Request("https://api.test/api/auth/sign-out", {
        method: "POST",
        headers: {
          "X-Balebase-Native-Origin": origin,
          Cookie: "session=example",
          "Content-Type": "application/json",
        },
        body: '{"confirm":"delete my account"}',
      }),
      "https://app.test",
    );
    expect(request.headers.get("Origin")).toBe("https://app.test");
    expect(request.headers.get("Cookie")).toBe("session=example");
    expect(await request.text()).toBe('{"confirm":"delete my account"}');
  },
);

it("never replaces a browser origin, even null or foreign, with the native marker", () => {
  for (const origin of ["https://evil.test", "null", "https://app.test"]) {
    const request = new Request("https://api.test", {
      headers: {
        Origin: origin,
        "X-Balebase-Native-Origin": "https://localhost",
      },
    });
    expect(withNativeOrigin(request, "https://app.test")).toBe(request);
    expect(request.headers.get("Origin")).toBe(origin);
  }
});

it("does not grant an origin to missing or unrecognized markers", () => {
  for (const marker of [
    null,
    "https://evil.test",
    "capacitor://evil.test",
    "https://localhost:1234",
  ]) {
    const headers = new Headers();
    if (marker) headers.set("X-Balebase-Native-Origin", marker);
    const request = new Request("https://api.test", { headers });
    expect(withNativeOrigin(request, "https://app.test")).toBe(request);
    expect(request.headers.get("Origin")).toBeNull();
  }
});
