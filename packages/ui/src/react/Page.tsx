import type { ReactNode } from "react";
import { cx } from "./cx";
import { InsideSection } from "./sectionContext";
import { TabStrip } from "./Tabs";

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
  tabsKind = "links",
  tabsLabel = "Sections",
  title,
}: {
  actions?: ReactNode;
  /** A link or button rendered above the eyebrow, e.g. "← Audits". */
  back?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  tabs?: ReactNode;
  /**
   * `links` for links to other pages; `panels` for `useSectionTabs` tabs
   * that switch sections of this page.
   */
  tabsKind?: "links" | "panels" | undefined;
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
      {tabs && (
        <TabStrip className="pageTabs" kind={tabsKind} label={tabsLabel}>
          {tabs}
        </TabStrip>
      )}
    </header>
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
