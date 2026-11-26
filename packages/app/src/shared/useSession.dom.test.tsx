import { expect, it, spyOn } from "bun:test";
import { act } from "react";
import { configureHost } from "../host";
import { holdTimers, installDom } from "../testing/dom";
import { useSession } from "./useSession";

const { mount, respond } = installDom({ url: "http://localhost:5173/" });

const session = {
  session: { id: "session-1", token: "token-1", userId: "user-1" },
  user: { email: "dan@example.com", id: "user-1", name: "Dan" },
};

let latest: ReturnType<typeof useSession> | undefined;

/** Hands the test the hook's latest value. */
function Probe() {
  latest = useSession();
  return null;
}

/** Lets pending requests and the store's updates land. */
async function until(done: () => boolean) {
  for (let tries = 0; tries < 50 && !done(); tries += 1)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(done()).toBe(true);
}

it("reads the session, refetches it, and stops watching after the last reader leaves", async () => {
  // The session store unmounts a second after its last reader leaves
  // (nanostores); held here, it runs when fired, while this file's window
  // exists.
  using storeUnmounts = holdTimers(1_000);
  // A fresh SDK, so another file's session store cannot answer first.
  configureHost({});
  const requests: string[] = [];
  respond(({ pathname }) => {
    requests.push(pathname);
    return Response.json(session);
  });
  const { unmount } = await mount(<Probe />);
  await until(() => latest?.isPending === false);
  expect(latest?.data?.user.id).toBe("user-1");
  expect(latest?.error).toBeNull();
  expect(requests).toEqual(["/api/auth/get-session"]);

  await act(async () => {
    await latest?.refetch();
  });
  expect(requests).toEqual(["/api/auth/get-session", "/api/auth/get-session"]);

  // Better Auth stops watching the session (focus, connectivity, other
  // tabs) once the store unmounts, which the SDK's docs rely on: nothing to
  // dispose.
  const fromWindow = spyOn(window, "removeEventListener");
  const fromDocument = spyOn(document, "removeEventListener");
  try {
    await unmount();
    const watching = ["visibilitychange", "storage", "online", "offline"];
    const stopped = () =>
      new Set(
        [...fromWindow.mock.calls, ...fromDocument.mock.calls]
          .map(([type]) => type)
          .filter((type) => watching.includes(type)),
      );
    expect(stopped()).toEqual(new Set());
    await storeUnmounts.fire();
    expect(stopped()).toEqual(new Set(watching));
  } finally {
    fromWindow.mockRestore();
    fromDocument.mockRestore();
  }
});
