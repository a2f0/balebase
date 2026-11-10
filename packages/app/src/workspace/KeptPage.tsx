import {
  Activity,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  initialKeptPage,
  type KeptPageEvent,
  keptPageTransition,
} from "./keptPageState";
import { currentHistoryPosition } from "./navigationGuard";

/**
 * A section's record page, shown over the page it was opened from. That page
 * stays mounted but hidden while records show, so Back or Forward to it
 * returns to it as it was left: its state, the rows it had loaded, and the
 * window's scroll position. A link to it starts it afresh, as before. Hidden,
 * it runs no effects; showing again re-runs them, so it refreshes.
 */
export function KeptPage({
  page,
  pathname,
  record,
}: {
  /** The section's page for a path that names no record. */
  page: (pathname: string) => ReactNode;
  pathname: string;
  /** The record page `pathname` names, if it names one. */
  record: ReactNode | undefined;
}) {
  const event: KeptPageEvent =
    record === undefined
      ? { entry: currentHistoryPosition(), pathname, type: "pageShown" }
      : { type: "recordShown" };
  const [state, setState] = useState(initialKeptPage);
  const kept = keptPageTransition(state, event);
  if (kept !== state) setState(kept);
  useKeptScroll(kept.status === "shown" ? kept.visit : undefined);
  return (
    <>
      {kept.status !== "none" && (
        <Activity
          key={kept.visit}
          mode={kept.status === "hidden" ? "hidden" : "visible"}
        >
          {page(kept.pathname)}
        </Activity>
      )}
      {record}
    </>
  );
}

/**
 * Puts the window back where it was when the page was hidden, before the
 * browser paints it again, if the page shows the same visit; `visit` is
 * undefined while it is hidden. The position is read as the page scrolls:
 * hiding it can shorten the document, which clamps the scroll before
 * anything could read it.
 */
function useKeptScroll(visit: number | undefined) {
  const kept = useRef<{ top: number; visit: number }>(undefined);
  useLayoutEffect(() => {
    if (visit === undefined) return;
    if (kept.current?.visit === visit) window.scrollTo(0, kept.current.top);
    const track = () => {
      kept.current = { top: window.scrollY, visit };
    };
    track();
    window.addEventListener("scroll", track, { passive: true });
    return () => window.removeEventListener("scroll", track);
  }, [visit]);
}
