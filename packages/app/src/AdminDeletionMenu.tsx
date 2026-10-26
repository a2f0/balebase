import { Button, ContextMenu } from "@balebase/ui/react";

export function AdminDeletionMenu({
  busy = false,
  disabled = false,
  label,
  name,
  onSelect,
  pending,
}: {
  busy?: boolean;
  disabled?: boolean;
  label: string;
  name: string;
  onSelect: () => void;
  pending: boolean;
}) {
  return (
    <ContextMenu
      items={[
        {
          disabled: disabled || busy,
          icon: pending ? "restore" : "trash",
          id: pending ? "restore" : "delete",
          label,
          onSelect,
        },
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
