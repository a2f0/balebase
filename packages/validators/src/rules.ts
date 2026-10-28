// Request rules as plain values. The contract's schemas are built from them,
// and the app imports them for its form limits without pulling in zod.

/** The types offered for new equipment. Adding one needs no migration. */
export const equipmentTypes = ["computer", "cell_phone", "monitor"] as const;
type EquipmentType = (typeof equipmentTypes)[number];

export function isEquipmentType(value: string): value is EquipmentType {
  return equipmentTypes.some((type) => type === value);
}

export const equipmentLimits = {
  make: 80,
  model: 120,
  serialNumber: 100,
} as const;

export const businessLimits = {
  city: 100,
  name: 120,
  streetAddress: 240,
} as const;

export const apiKeyAccessLevels = ["read", "write"] as const;

/** Days until a new API key expires; a key may also never expire. */
export const apiKeyExpirationDays = [30, 90, 365] as const;

export const apiKeyNameMaxLength = 100;

export const financeLimits = {
  annotationLabel: 50,
  annotationLabels: 12,
  annotationNote: 2000,
  categoryName: 60,
} as const;

/** What membership in a group can grant. */
export const organizationCapabilities = ["finance"] as const;

export const groupLimits = { members: 100, name: 100 } as const;

export const libraryFolderNameMaxLength = 80;

export const issuePriorities = ["low", "medium", "high", "critical"] as const;

export const issueLimits = { description: 2000, title: 300 } as const;
