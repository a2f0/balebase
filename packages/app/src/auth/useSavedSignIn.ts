import {
  type FormEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
} from "react";
import { nativeHost, type SavedSignIn } from "../host";
import {
  initialSavedSignInOffer,
  type SavedSignInOfferEvent,
  type SavedSignInOfferState,
  savedSignInOfferTransition,
} from "./savedSignInOfferState";

/**
 * Keeps autofill provenance only for this form's lifetime, never in storage.
 * Where the shell can offer saved sign-ins itself (Android), offers them once,
 * when sign-in first shows, and fills the form with the one chosen
 * (savedSignInOfferState.ts).
 */
export function useSavedSignIn(
  signInShown: boolean,
  fill: (credential: SavedSignIn) => void,
) {
  const saved = useRef<SavedSignIn | undefined>(undefined);
  // A ref, not state: nothing renders from it, and StrictMode's effect replay
  // must find the request the first run started rather than ask again. An
  // answer after unmounting fills nothing, so unmounting needs no event.
  const offer = useRef(initialSavedSignInOffer);
  const requests = useRef(0);
  const answered = useEffectEvent(
    (request: number, credential: SavedSignIn | undefined) => {
      if (!send(offer, { type: "answered", request }) || !credential) return;
      saved.current = credential;
      fill(credential);
    },
  );
  useEffect(() => {
    const choose = nativeHost()?.chooseSavedSignIn;
    if (!signInShown || !choose) return;
    requests.current += 1;
    const request = requests.current;
    if (!send(offer, { type: "signInShown", request })) return;
    choose().then(
      (credential) => answered(request, credential),
      // The offer is optional: the person can still type their sign-in.
      () => answered(request, undefined),
    );
  }, [signInShown]);
  return {
    /** Stops a pending offer from filling the form the person moved on from. */
    abandonOffer: () => {
      send(offer, { type: "abandoned" });
    },
    /** The form changed modes: forgets provenance and abandons the offer. */
    clear: () => {
      saved.current = undefined;
      send(offer, { type: "abandoned" });
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

/** Applies `event` to the offer; true when it changed the offer's state. */
function send(
  offer: RefObject<SavedSignInOfferState>,
  event: SavedSignInOfferEvent,
) {
  const previous = offer.current;
  offer.current = savedSignInOfferTransition(previous, event);
  return offer.current !== previous;
}
