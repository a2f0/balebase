import { type FormEvent, useRef } from "react";
import { nativeHost, type SavedSignIn } from "./host";

/** Keeps autofill provenance only for this form's lifetime, never in storage. */
export function useSavedSignIn(
  onEmail: (value: string) => void,
  onPassword: (value: string) => void,
) {
  const saved = useRef<SavedSignIn | undefined>(undefined);
  const choose = nativeHost()?.chooseSavedSignIn;
  return {
    clear: () => {
      saved.current = undefined;
    },
    choose: choose
      ? async () => {
          const credential = await choose();
          if (!credential) return;
          saved.current = credential;
          onEmail(credential.username);
          onPassword(credential.password);
        }
      : undefined,
    onInput(event: FormEvent<HTMLFormElement>) {
      const input = event.target as HTMLInputElement;
      // WKWebView's login AutoFill uses setValueForUser, which dispatches a
      // trusted plain Event. Typing and paste dispatch InputEvent instead.
      // Unlike Safari's own fill, this path need not set the :autofill state.
      if (
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
      if (
        saved.current?.username === username &&
        saved.current.password === password
      )
        return true;
      // Other engines mark autofilled fields until the person edits them.
      // Require both fields so changing the account still offers to save it.
      return ["email", "password"].every((name) => {
        const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
        return input?.matches(":autofill") ?? false;
      });
    },
  };
}
