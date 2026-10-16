import type { IconName } from "@tearleads/ui/react";
import { formatLabel } from "./labels";

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
    item.purchaseDate && `Purchased ${formatPurchaseDate(item.purchaseDate)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A purchase date ("2026-03-01") in the viewer's format, on its own day. */
export function formatPurchaseDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${value}T12:00:00`),
  );
}
