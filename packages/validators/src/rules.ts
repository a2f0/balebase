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

export const auditLimits = {
  answer: 2000,
  description: 2000,
  itemId: 100,
  itemsPerSection: 100,
  name: 200,
  prompt: 500,
  sections: 50,
  sectionTitle: 200,
} as const;

export const contractLimits = {
  /** Of a contract template. */
  description: 2000,
  fieldLabel: 100,
  fields: 500,
  message: 2000,
  reminderDays: 30,
  signerEmail: 254,
  signerName: 120,
  signers: 20,
  title: 200,
} as const;

/** The two-letter codes of the US states and DC. */
export const usStateCodes = [
  "AK",
  "AL",
  "AR",
  "AZ",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "GA",
  "HI",
  "IA",
  "ID",
  "IL",
  "IN",
  "KS",
  "KY",
  "LA",
  "MA",
  "MD",
  "ME",
  "MI",
  "MN",
  "MO",
  "MS",
  "MT",
  "NC",
  "ND",
  "NE",
  "NH",
  "NJ",
  "NM",
  "NV",
  "NY",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VA",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
] as const;
export type UsStateCode = (typeof usStateCodes)[number];

export function isUsStateCode(code: string): code is UsStateCode {
  return usStateCodes.some((state) => state === code);
}

export const employeeRequirementLimits = {
  city: 100,
  requirements: 20,
  title: 100,
} as const;
