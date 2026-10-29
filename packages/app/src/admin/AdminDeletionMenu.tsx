import { Button, ContextMenu } from "@balebase/ui/react";

export function AdminDeletionMenu({
  busy = false,
  deletionDisabled,
  disabled = false,
  extraItems = [],
  label,
  name,
  onSelect,
  pending,
}: {
  busy?: boolean;
  /** Disables only the deletion item; defaults to `disabled`. */
  deletionDisabled?: boolean;
  disabled?: boolean;
  /** Further actions listed after the deletion item. */
  extraItems?: readonly {
    disabled?: boolean;
    icon: "lock";
    id: string;
    label: string;
    onSelect: () => void;
  }[];
  label: string;
  name: string;
  onSelect: () => void;
  pending: boolean;
}) {
  return (
    <ContextMenu
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
      label={`Actions for ${name}`}
      openOnClick
    >
      {(props) => (
        <Button
          {...props}
          aria-haspopup="menu"
          aria-label={`Actions for ${name}`}
          busy={busy}
          disabled={disabled}
          icon="more"
          size="sm"
          variant="ghost"
        />
      )}
    </ContextMenu>
  );
}
