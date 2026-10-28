import type { IconName } from "@balebase/ui/react";
import { formatCalendarDate, formatLabel } from "./labels";

const typeLabels: Record<string, { icon: IconName; label: string }> = {
  cell_phone: { icon: "cellPhone", label: "Cell phone" },
  computer: { icon: "computer", label: "Computer" },
  monitor: { icon: "monitor", label: "Monitor" },
};

/** Display name for an equipment type, including types added later. */
export function equipmentTypeLabel(type: string) {
  return typeLabels[type]?.label ?? formatLabel(type);
}

export function equipmentTypeIcon(type: string): IconName {
  return typeLabels[type]?.icon ?? "equipment";
}

/** "Apple MacBook Pro", the name equipment is known by in lists and links. */
export function equipmentName(item: { make: string; model: string }) {
  return `${item.make} ${item.model}`.trim();
}

/** "Computer · C02XYZ · Purchased Mar 1, 2026", omitting what is not recorded. */
export function equipmentMeta(item: {
  purchaseDate: string | null;
  serialNumber: string | null;
  type: string;
}) {
  return [
    equipmentTypeLabel(item.type),
    item.serialNumber,
    item.purchaseDate && `Purchased ${formatCalendarDate(item.purchaseDate)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
