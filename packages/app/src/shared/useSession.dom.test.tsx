import { expect, it } from "bun:test";
import { act } from "react";
import { configureHost } from "../host";
import { installDom } from "../testing/dom";
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

it("reads the session from the SDK's auth client and refetches it", async () => {
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

  // The store stops watching the session (window listeners, other tabs) a
  // second after its last reader leaves (nanostores' STORE_UNMOUNT_DELAY).
  // Let that happen while this file's window exists, not in a later file.
  await unmount();
  await new Promise((resolve) => setTimeout(resolve, 1_050));
});
