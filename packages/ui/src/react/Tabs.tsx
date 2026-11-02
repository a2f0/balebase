import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";

export interface SectionTab<Id extends string = string> {
  id: Id;
  label: ReactNode;
}

/**
 * Tabs that switch between sections of one page, such as a record's details
 * and its activity. Pass `tabs` to `PageHeader` (with `tabsKind="panels"`) or
 * to `SectionTabs`, and wrap each section in `panel(id, …)`.
 *
 * By default every panel stays mounted and only the selected one shows, so a
 * hidden section keeps its unsaved edits and its feed stays current;
 * `mount: "selected"` renders only the selected panel, so switching starts it
 * afresh. A falsy entry
 * leaves its tab out, for sections only some people see; a single section
 * shows without a tab strip.
 */
export function useSectionTabs<Id extends string>(
  entries: readonly (SectionTab<Id> | false | null | undefined)[],
  { initial, mount = "all" }: { initial?: Id; mount?: "all" | "selected" } = {},
) {
  const tabs = entries.filter((entry): entry is SectionTab<Id> =>
    Boolean(entry),
  );
  const base = useId();
  const [chosen, setChosen] = useState<Id | undefined>(initial);
  const selected = tabs.find(({ id }) => id === chosen)?.id ?? tabs[0]?.id;
  // Section IDs can hold spaces ("Claude Code"), so DOM IDs use positions.
  const position = (id: Id) => tabs.findIndex((tab) => tab.id === id);
  const tabId = (id: Id) => `${base}-tab-${position(id)}`;
  const panelId = (id: Id) => `${base}-panel-${position(id)}`;
  const strip = tabs.length > 1;
  return {
    panel(id: Id, children: ReactNode) {
      if (position(id) < 0) return null;
      if (mount === "selected" && id !== selected) return null;
      // A lone section has no tab to name it, so it is an ordinary block.
      if (!strip) {
        return (
          <div className="tabPanel" key={id}>
            {children}
          </div>
        );
      }
      return (
        <div
          aria-labelledby={tabId(id)}
          className="tabPanel"
          hidden={id !== selected}
          id={panelId(id)}
          key={id}
          role="tabpanel"
          // A panel that opens with text still gives keyboard users a stop.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels are focusable, as the ARIA tabs pattern recommends.
          tabIndex={0}
        >
          {children}
        </div>
      );
    },
    select: setChosen,
    selected,
    tabs:
      tabs.length < 2
        ? undefined
        : tabs.map(({ id, label }) => (
            <button
              aria-controls={panelId(id)}
              aria-selected={id === selected}
              className="tab"
              id={tabId(id)}
              key={id}
              onClick={() => setChosen(id)}
              onKeyDown={moveBetweenTabs}
              role="tab"
              tabIndex={id === selected ? 0 : -1}
              type="button"
            >
              {label}
            </button>
          )),
  };
}

/** What `useSectionTabs` returns, for passing its tabs and panels down. */
export type SectionTabState<Id extends string> = ReturnType<
  typeof useSectionTabs<Id>
>;

/** Arrow keys, Home, and End select and focus another tab in the strip. */
function moveBetweenTabs(event: KeyboardEvent<HTMLButtonElement>) {
  const tabs = [
    ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      ':scope > [role="tab"]',
    ) ?? []),
  ];
  const index = tabs.indexOf(event.currentTarget);
  const next = new Map([
    ["ArrowLeft", (index + tabs.length - 1) % tabs.length],
    ["ArrowRight", (index + 1) % tabs.length],
    ["End", tabs.length - 1],
    ["Home", 0],
  ]).get(event.key);
  const tab = next === undefined ? undefined : tabs[next];
  if (!tab) return;
  event.preventDefault();
  tab.focus();
  tab.click();
}

/** A tab strip inside a page body, for sections below other tabs. */
export function SectionTabs({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  if (!children) return null;
  return (
    <TabStrip className="sectionTabs" kind="panels" label={label}>
      {children}
    </TabStrip>
  );
}

/**
 * Links to other pages (`links`), or tabs that switch sections of this page
 * (`panels`). A narrow screen scrolls the strip sideways, so bring the
 * current tab into view whenever it changes, but leave a strip the user
 * scrolled alone.
 */
export function TabStrip({
  children,
  className,
  kind,
  label,
}: {
  children: ReactNode;
  className: string;
  kind: "links" | "panels";
  label: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const shown = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const element = strip.current;
    const current = element?.querySelector(
      '[aria-current="page"], [aria-selected="true"]',
    );
    if (!element || !current || current === shown.current) return;
    shown.current = current;
    const bounds = element.getBoundingClientRect();
    const tab = current.getBoundingClientRect();
    if (tab.left < bounds.left || tab.right > bounds.right) {
      element.scrollLeft +=
        tab.left - bounds.left - (bounds.width - tab.width) / 2;
    }
  });
  return kind === "links" ? (
    <nav aria-label={label} className={cx("tabs", className)} ref={strip}>
      {children}
    </nav>
  ) : (
    <div
      aria-label={label}
      className={cx("tabs", className)}
      ref={strip}
      role="tablist"
    >
      {children}
    </div>
  );
}
