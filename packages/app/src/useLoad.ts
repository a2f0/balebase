import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./errors";

/**
 * Loads on mount and whenever `load` changes identity, so pass a
 * `useCallback`. A new loader clears the old data; `reload` keeps it visible
 * while refreshing. A response that arrives after a newer request or after
 * unmount is dropped.
 */
export function useLoad<T>(load: () => Promise<T>, fallback: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await load();
      if (request === latest.current) setData(() => next);
    } catch (cause) {
      if (request === latest.current) setError(errorMessage(cause, fallback));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [fallback, load]);
  useEffect(() => {
    setData(undefined);
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);
  return { data, error, loading, reload, setData };
}
