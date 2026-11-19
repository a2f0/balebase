import { useReducer, useRef } from "react";
import { clipboardTransition } from "./clipboardState";

export function useClipboard() {
  const [state, dispatch] = useReducer(clipboardTransition, { status: "idle" });
  const sequence = useRef(0);
  async function copy(
    text: string,
    message = "Copied to clipboard.",
    failure = "Copy failed. Select it and copy manually.",
  ) {
    const request = ++sequence.current;
    dispatch({ type: "copy", request });
    try {
      await navigator.clipboard.writeText(text);
      dispatch({
        type: "settled",
        request,
        notice: { message, tone: "success" },
      });
    } catch {
      dispatch({
        type: "settled",
        request,
        notice: { message: failure, tone: "danger" },
      });
    }
  }
  return {
    copy,
    notice: state.status === "finished" ? state.notice : undefined,
  };
}
