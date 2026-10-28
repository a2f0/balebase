import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Renders a page into one DOM node that whichever layout is showing hosts, so
 * moving between the standalone page and the workspace shell, or past a
 * loading screen, never remounts it or loses unsaved local work.
 */
export function useOfflineSlot(page: ReactNode) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  return {
    portal: page ? createPortal(page, host) : null,
    slot: page ? <OfflineSlot host={host} /> : undefined,
  };
}

function OfflineSlot({ host }: { host: HTMLElement }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    container.current?.append(host);
    return () => host.remove();
  }, [host]);
  return <div ref={container} style={{ display: "contents" }} />;
}
