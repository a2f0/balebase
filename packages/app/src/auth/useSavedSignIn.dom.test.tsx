import { afterEach, expect, it } from "bun:test";
import { act, StrictMode } from "react";
import { configureHost, type SavedSignIn } from "../host";
import { installDom } from "../testing/dom";
import { useSavedSignIn } from "./useSavedSignIn";

const { mount } = installDom();

afterEach(() => configureHost({}));

function SignInForm({ fill }: { fill: (credential: SavedSignIn) => void }) {
  useSavedSignIn(true, fill);
  return null;
}

it("drops a saved sign-in chosen after the page closed", async () => {
  const { promise, resolve } = Promise.withResolvers<SavedSignIn>();
  let requests = 0;
  configureHost({
    native: {
      appUrl: "https://app.test",
      chooseSavedSignIn: () => {
        requests += 1;
        return promise;
      },
      origin: "https://localhost",
      saveFile: async () => true,
      savePassword: async () => {},
    },
  });
  const filled: SavedSignIn[] = [];
  const view = await mount(
    <StrictMode>
      <SignInForm fill={(credential) => filled.push(credential)} />
    </StrictMode>,
  );
  expect(requests).toBe(1);

  await view.unmount();
  await act(async () =>
    resolve({ username: "owner@example.com", password: "a saved password" }),
  );
  expect(filled).toEqual([]);
});
