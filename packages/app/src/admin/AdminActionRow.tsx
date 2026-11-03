import { ContextMenu, MenuButton } from "@balebase/ui/react";
import type { ReactNode } from "react";

/**
 * A root admin table row whose actions open from its last cell's menu button,
 * or by right-clicking (or pressing the menu key) anywhere on the row.
 */
export function AdminActionRow({
  busy = false,
  children,
  deletionDisabled,
  disabled = false,
  extraItems = [],
  label,
  name,
  onSelect,
  pending,
}: {
  busy?: boolean;
  /** The row's cells before its actions cell. */
  children: ReactNode;
  /** Disables only the deletion item; defaults to `disabled`. */
  deletionDisabled?: boolean;
  /** Keeps the menu closed, as while another row's action runs. */
  disabled?: boolean;
  /** Further actions listed after the deletion item. */
  extraItems?: readonly {
    disabled?: boolean;
    icon: "list" | "lock";
    id: string;
    label: string;
    onSelect: () => void;
  }[];
  label: string;
  name: string;
  onSelect: () => void;
  pending: boolean;
}) {
  const menuLabel = `Actions for ${name}`;
  return (
    <ContextMenu
      disabled={disabled}
      items={[
        {
          disabled: (deletionDisabled ?? disabled) || busy,
          icon: pending ? "restore" : "trash",
          id: pending ? "restore" : "delete",
          label,
          onSelect,
        },
        ...extraItems.map((item) => ({
          ...item,
          disabled: item.disabled || busy,
        })),
      ]}
      label={menuLabel}
    >
      {(row, menuButton) => (
        <tr {...row}>
          {children}
          <td className="adminActions tableActions">
            <MenuButton
              {...menuButton}
              busy={busy}
              disabled={disabled}
              label={menuLabel}
            />
          </td>
        </tr>
      )}
    </ContextMenu>
  );
}
