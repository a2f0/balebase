// Issue rules the API enforces and the app checks before sending. This module
// stays free of zod so the app bundle can import it.

export const issuePriorities = ["low", "medium", "high", "critical"] as const;

export const issueLimits = { description: 2000, title: 300 } as const;

/** The image formats the API stores. */
export const issueImageTypes: readonly string[] = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
];
export const maxIssueImages = 10;
export const maxIssueImageBytes = 10 * 1024 * 1024;

/**
 * Whether the API accepts an image upload declared as `contentType`. The API
 * reads the format from the bytes, so application/octet-stream is accepted
 * and checked there.
 */
export function issueImageTypeAccepted(contentType: string) {
  const type = contentType.toLowerCase();
  return type === "application/octet-stream" || issueImageTypes.includes(type);
}

/**
 * Why the API would refuse these images on an issue with `availableSlots`
 * left, or undefined when it would take them.
 */
export function issueImageProblem(
  files: readonly { size: number; type: string }[],
  availableSlots: number,
) {
  if (files.length > availableSlots) {
    return `You can attach ${Math.max(availableSlots, 0)} more image${availableSlots === 1 ? "" : "s"}.`;
  }
  // The API client sends a file the browser could not type as
  // application/octet-stream.
  if (
    files.some(
      (file) =>
        !issueImageTypeAccepted(file.type || "application/octet-stream"),
    )
  ) {
    return "Images must be JPEG, PNG, GIF, or WebP files.";
  }
  if (files.some((file) => file.size === 0)) {
    return "Images must not be empty.";
  }
  if (files.some((file) => file.size > maxIssueImageBytes)) {
    return "Images must be 10 MB or smaller.";
  }
  return undefined;
}
