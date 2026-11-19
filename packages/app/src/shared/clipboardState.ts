interface CopyNotice {
  message: string;
  tone: "danger" | "success";
}

export type ClipboardState =
  | { status: "idle" }
  | { status: "copying"; request: number }
  | { status: "finished"; notice: CopyNotice };

type ClipboardEvent =
  | { type: "copy"; request: number }
  | { type: "settled"; request: number; notice: CopyNotice };

export function clipboardTransition(
  state: ClipboardState,
  event: ClipboardEvent,
): ClipboardState {
  switch (event.type) {
    case "copy":
      return { status: "copying", request: event.request };
    case "settled":
      return state.status === "copying" && state.request === event.request
        ? { status: "finished", notice: event.notice }
        : state;
  }
}
