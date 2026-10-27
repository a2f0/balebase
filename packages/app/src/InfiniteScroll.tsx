import { Button } from "@balebase/ui/react";
import { useCallback, useEffect, useRef } from "react";

/** Load near the end of a list, with a button for keyboards and retries. */
export function InfiniteScroll({
  autoLoad,
  busy,
  children,
  cursor,
  disabled = false,
  onLoadMore,
}: {
  autoLoad: boolean;
  busy: boolean;
  children: string;
  cursor: string;
  disabled?: boolean;
  onLoadMore: () => Promise<boolean>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const requestedCursor = useRef<string>(undefined);
  const load = useCallback(async () => {
    if (pending.current || busy || disabled) return;
    pending.current = true;
    try {
      if (await onLoadMore()) requestedCursor.current = cursor;
    } finally {
      pending.current = false;
    }
  }, [busy, cursor, disabled, onLoadMore]);

  useEffect(() => {
    const element = sentinel.current;
    if (
      !element ||
      !autoLoad ||
      busy ||
      disabled ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          active &&
          !pending.current &&
          requestedCursor.current !== cursor &&
          entries.some((entry) => entry.isIntersecting)
        ) {
          void load();
        }
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [autoLoad, busy, cursor, disabled, load]);

  return (
    <div ref={sentinel}>
      <Button
        busy={busy}
        disabled={disabled}
        onClick={() => void load()}
        size="sm"
      >
        {children}
      </Button>
    </div>
  );
}
