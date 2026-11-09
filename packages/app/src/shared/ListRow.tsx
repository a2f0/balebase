import {
  Button,
  ContextMenu,
  cx,
  Icon,
  type IconName,
  MenuButton,
} from "@balebase/ui/react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { AppLink } from "./AppLink";

/** One action in a row's menu. */
export type ListRowItem = ComponentProps<typeof ContextMenu>["items"][number];

/** What opening a row does: follow an app link, or run an action. */
export type ListRowOpen =
  | { href: string; onNavigate: (pathname: string) => void }
  | { label?: string | undefined; onClick: () => void };

/**
 * A list row: an optional icon, a title over its meta, any details, and a
 * menu of the row's actions, opened from its menu button or by
 * right-clicking (or pressing the menu key) anywhere on the row. With `open`,
 * the title covers the whole row, so a click anywhere but the menu button
 * opens it. The title keeps to one line and ends in an ellipsis; unless
 * `wrap` is set, the details and menu button stay on its line. A row without
 * actions shows no menu button.
 */
export function ListRow({
  actionsRef,
  children,
  className,
  icon,
  items = [],
  label,
  meta,
  open,
  title,
  wrap = false,
}: {
  /** The menu button's container, for returning focus to the button. */
  actionsRef?: Ref<HTMLDivElement> | undefined;
  /** Details after the title and meta, such as badges or amounts. */
  children?: ReactNode;
  className?: string | undefined;
  icon?: IconName | undefined;
  items?: readonly ListRowItem[] | undefined;
  /** Names the menu and its button; "Actions for" the title by default. */
  label?: string | undefined;
  meta?: ReactNode;
  open?: ListRowOpen | undefined;
  title: string;
  /** Lets the details wrap below the title when the row is narrow. */
  wrap?: boolean | undefined;
}) {
  const menuLabel = label ?? `Actions for ${title}`;
  return (
    <ContextMenu items={items} label={menuLabel}>
      {(target, menuButton) => (
        <li
          className={cx(
            "row",
            open && "rowInteractive",
            !wrap && "rowInline",
            className,
          )}
          {...target}
        >
          {icon && (
            <span className="iconTile">
              <Icon name={icon} size={20} />
            </span>
          )}
          <div className="rowMain">
            <RowTitle open={open} title={title} />
            {meta !== undefined && <span className="rowMeta">{meta}</span>}
          </div>
          {children}
          {items.length > 0 && (
            <div className="rowActions" ref={actionsRef}>
              <MenuButton {...menuButton} label={menuLabel} />
            </div>
          )}
        </li>
      )}
    </ContextMenu>
  );
}

function RowTitle({
  open,
  title,
}: {
  open: ListRowOpen | undefined;
  title: string;
}) {
  if (!open) return <span className="rowTitle truncate">{title}</span>;
  if ("href" in open)
    return (
      <AppLink
        className="rowTitle rowTarget truncate"
        href={open.href}
        onNavigate={open.onNavigate}
      >
        {title}
      </AppLink>
    );
  return (
    <Button
      aria-label={open.label}
      className="rowTitle rowTarget truncate"
      onClick={open.onClick}
      variant="link"
    >
      {title}
    </Button>
  );
}
