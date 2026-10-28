import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act, useCallback } from "react";
import type { Root } from "react-dom/client";
import { useAction } from "./useAction";
import { useCursorPages } from "./useCursorPages";
import { useLoad } from "./useLoad";

const dom = new Window();
const globals = {
  document: dom.document,
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;

beforeAll(async () => {
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

/** Renders a hook and returns a getter for its latest result. */
async function renderHook<Props, Result>(
  hook: (props: Props) => Result,
  props: Props,
) {
  let result: Result | undefined;
  function Probe(current: { props: Props }) {
    result = hook(current.props);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe props={props} />));
  return {
    current: () => result as Result,
    rerender: (next: Props) =>
      act(async () => root?.render(<Probe props={next} />)),
  };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe("useLoad", () => {
  it("drops a response that arrives after a newer key's", async () => {
    const pending = new Map([
      ["a", deferred<string>()],
      ["b", deferred<string>()],
    ]);
    const hook = await renderHook(
      ({ id }: { id: string }) =>
        useLoad(
          useCallback(() => pending.get(id)?.promise ?? Promise.reject(), [id]),
          "Could not load.",
        ),
      { id: "a" },
    );
    expect(hook.current().loading).toBe(true);
    await hook.rerender({ id: "b" });
    await act(async () => pending.get("b")?.resolve("b data"));
    await act(async () => pending.get("a")?.resolve("a data"));
    expect(hook.current().data).toBe("b data");
    expect(hook.current().loading).toBe(false);
  });

  it("keeps data while reloading and shows a readable error", async () => {
    let calls = 0;
    const hook = await renderHook(
      ({ load }: { load: () => Promise<number> }) =>
        useLoad(load, "Could not load."),
      {
        load: async () => {
          calls += 1;
          if (calls > 1) throw new TypeError("Failed to fetch");
          return calls;
        },
      },
    );
    expect(hook.current().data).toBe(1);
    await act(() => hook.current().reload());
    expect(hook.current().data).toBe(1);
    expect(hook.current().error).toBe(
      "Could not connect. Check your connection and try again.",
    );
    expect(hook.current().loading).toBe(false);
  });

  it("lets a reload supersede the load still in flight", async () => {
    const responses = [deferred<string>(), deferred<string>()];
    let calls = 0;
    const load = () =>
      (responses[calls++] as PromiseWithResolvers<string>).promise;
    const hook = await renderHook(
      ({ load }: { load: () => Promise<string> }) =>
        useLoad(load, "Could not load."),
      { load },
    );
    let reloaded: Promise<void> | undefined;
    await act(async () => {
      reloaded = hook.current().reload();
    });
    await act(async () => responses[1]?.resolve("fresh"));
    await act(async () => responses[0]?.resolve("stale"));
    await reloaded;
    expect(hook.current().data).toBe("fresh");
  });
});

describe("useAction", () => {
  it("reports busy, success notices, and mapped errors", async () => {
    const hook = await renderHook(() => useAction("Could not save."), {});
    const work = deferred<number>();
    let finished: Promise<boolean> | undefined;
    await act(async () => {
      finished = hook.current().run(
        () => work.promise,
        (count) => `Saved ${count}.`,
      );
    });
    expect(hook.current().busy).toBe(true);
    await act(async () => work.resolve(2));
    expect(await finished).toBe(true);
    expect(hook.current()).toMatchObject({
      busy: false,
      error: undefined,
      notice: "Saved 2.",
    });

    let failed: boolean | undefined;
    await act(async () => {
      failed = await hook.current().run(async () => {
        throw new DOMException("Slow", "TimeoutError");
      }, "Saved.");
    });
    expect(failed).toBe(false);
    expect(hook.current()).toMatchObject({
      busy: false,
      error: "The request took too long. Try again.",
      notice: undefined,
    });
  });
});

describe("useCursorPages", () => {
  it("appends later pages and reloads from the first", async () => {
    const requests: (string | undefined)[] = [];
    const fetchPage = async (cursor?: string) => {
      requests.push(cursor);
      return cursor
        ? { items: ["c"], nextCursor: null }
        : { items: ["a", "b"], nextCursor: "next" };
    };
    const hook = await renderHook(
      ({ fetch }: { fetch: typeof fetchPage }) =>
        useCursorPages(fetch, "Could not load."),
      { fetch: fetchPage },
    );
    expect(hook.current().items).toEqual(["a", "b"]);
    await act(async () => {
      expect(await hook.current().loadMore()).toBe(true);
    });
    expect(hook.current().items).toEqual(["a", "b", "c"]);
    expect(hook.current().nextCursor).toBeNull();
    await act(async () => {
      expect(await hook.current().loadMore()).toBe(false);
    });
    await act(async () => hook.current().reload());
    expect(hook.current().items).toEqual(["a", "b"]);
    expect(requests).toEqual([undefined, "next", undefined]);
  });

  it("drops a later page that arrives after the list changed", async () => {
    const stale = deferred<{ items: string[]; nextCursor: null }>();
    const pages = (view: string) => async (cursor?: string) =>
      cursor ? stale.promise : { items: [view], nextCursor: "next" };
    const active = pages("active");
    const deleted = pages("deleted");
    const hook = await renderHook(
      ({ fetch }: { fetch: ReturnType<typeof pages> }) =>
        useCursorPages(fetch, "Could not load."),
      { fetch: active },
    );
    let loaded: Promise<boolean> | undefined;
    await act(async () => {
      loaded = hook.current().loadMore();
    });
    expect(hook.current().loadingMore).toBe(true);
    await hook.rerender({ fetch: deleted });
    expect(hook.current().loadingMore).toBe(false);
    await act(async () =>
      stale.resolve({ items: ["stale"], nextCursor: null }),
    );
    await loaded;
    expect(hook.current().items).toEqual(["deleted"]);
    expect(hook.current().nextCursor).toBe("next");
  });

  it("keeps loaded items and shows the error when a later page fails", async () => {
    const fetchPage = async (cursor?: string) => {
      if (cursor) throw new TypeError("Load failed");
      return { items: ["a"], nextCursor: "next" };
    };
    const hook = await renderHook(
      ({ fetch }: { fetch: typeof fetchPage }) =>
        useCursorPages(fetch, "Could not load."),
      { fetch: fetchPage },
    );
    await act(async () => {
      await hook.current().loadMore();
    });
    expect(hook.current().items).toEqual(["a"]);
    expect(hook.current().nextCursor).toBe("next");
    expect(hook.current().error).toBe(
      "Could not connect. Check your connection and try again.",
    );
  });
});
