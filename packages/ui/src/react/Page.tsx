import { type ReactNode, useLayoutEffect, useRef } from "react";
import { cx } from "./cx";
import { InsideSection } from "./sectionContext";

export function Page({
  children,
  className,
  narrow = false,
}: {
  children: ReactNode;
  className?: string | undefined;
  narrow?: boolean | undefined;
}) {
  return (
    <div className={cx("page", narrow && "pageNarrow", className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  actions,
  back,
  description,
  eyebrow,
  tabs,
  tabsLabel = "Sections",
  title,
}: {
  actions?: ReactNode;
  /** A link or button rendered above the eyebrow, e.g. "← Audits". */
  back?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  tabs?: ReactNode;
  tabsLabel?: string | undefined;
  title: ReactNode;
}) {
  return (
    <header className="pageHeader">
      <div className="pageHeaderInner">
        <div className="pageHeaderText">
          {back && <div className="pageBack">{back}</div>}
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="pageTitle">{title}</h1>
          {description && <p className="pageDescription">{description}</p>}
        </div>
        {actions && <div className="pageActions">{actions}</div>}
      </div>
      {tabs && <PageTabs label={tabsLabel}>{tabs}</PageTabs>}
    </header>
  );
}

/**
 * A narrow screen scrolls the tab strip sideways, so bring the current tab
 * into view whenever it changes, but leave a strip the user scrolled alone.
 */
function PageTabs({ children, label }: { children: ReactNode; label: string }) {
  const strip = useRef<HTMLElement>(null);
  const shown = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const nav = strip.current;
    const current = nav?.querySelector(
      '[aria-current="page"], [aria-selected="true"]',
    );
    if (!nav || !current || current === shown.current) return;
    shown.current = current;
    const bounds = nav.getBoundingClientRect();
    const tab = current.getBoundingClientRect();
    if (tab.left < bounds.left || tab.right > bounds.right) {
      nav.scrollLeft += tab.left - bounds.left - (bounds.width - tab.width) / 2;
    }
  });
  return (
    <nav aria-label={label} className="tabs pageTabs" ref={strip}>
      {children}
    </nav>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <div className={cx("pageBody", className)}>{children}</div>;
}

export function PageSection({
  actions,
  children,
  className,
  description,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
  description?: ReactNode;
  title: ReactNode;
}) {
  return (
    <section className={cx("pageSection", className)}>
      <div className="sectionHeader">
        <div className="sectionHeading">
          <h2 className="sectionTitle">{title}</h2>
          {description && <p className="sectionDescription">{description}</p>}
        </div>
        {actions}
      </div>
      <InsideSection value={true}>{children}</InsideSection>
    </section>
  );
}
