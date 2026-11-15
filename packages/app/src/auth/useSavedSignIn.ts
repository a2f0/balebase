import { type FormEvent, useEffect, useEffectEvent, useRef } from "react";
import { nativeHost, type SavedSignIn } from "../host";

/**
 * Keeps autofill provenance only for this form's lifetime, never in storage.
 * Where the shell can offer saved sign-ins itself (Android), offers them once,
 * when `offer` first holds, and fills the form with the one chosen.
 */
export function useSavedSignIn(
  offer: boolean,
  fill: (credential: SavedSignIn) => void,
) {
  const saved = useRef<SavedSignIn | undefined>(undefined);
  // Set before the request starts, so StrictMode's effect replay asks once.
  const offered = useRef(false);
  const chosen = useEffectEvent((credential: SavedSignIn) => {
    saved.current = credential;
    fill(credential);
  });
  useEffect(() => {
    const choose = nativeHost()?.chooseSavedSignIn;
    if (!offer || !choose || offered.current) return;
    offered.current = true;
    choose().then(
      (credential) => {
        if (credential) chosen(credential);
      },
      () => {
        // The offer is optional: the person can still type their sign-in.
      },
    );
  }, [offer]);
  return {
    clear: () => {
      saved.current = undefined;
    },
    onInput(event: FormEvent<HTMLFormElement>) {
      const input = event.target;
      // WKWebView's login AutoFill uses setValueForUser, which dispatches a
      // trusted plain Event. Typing and paste dispatch InputEvent instead.
      // Unlike Safari's own fill, this path need not set the :autofill state.
      if (
        !nativeHost() ||
        !(input instanceof HTMLInputElement) ||
        input.name !== "password" ||
        !event.nativeEvent.isTrusted ||
        "inputType" in event.nativeEvent
      )
        return;
      const email =
        event.currentTarget.querySelector<HTMLInputElement>('[name="email"]');
      if (email?.value && input.value) {
        saved.current = { username: email.value, password: input.value };
      }
    },
    isSaved(form: HTMLFormElement, username: string, password: string) {
      if (!nativeHost()) return false;
      if (
        saved.current?.username === username &&
        saved.current.password === password
      )
        return true;
      // Other engines mark autofilled fields until the person edits them.
      // Require both fields so changing the account still offers to save it.
      try {
        return ["email", "password"].every((name) => {
          const input = form.querySelector<HTMLInputElement>(
            `[name="${name}"]`,
          );
          return input?.matches(":autofill") ?? false;
        });
      } catch {
        // An older WebView may not support this selector. Detection must never
        // prevent signing in; offer to save normally when provenance is unknown.
        return false;
      }
    },
  };
}
