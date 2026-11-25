import { createContext, useContext } from "react";

/**
 * Whether the signed-in person's groups grant Background checks, so screens
 * outside the Background checks page offer them only to those who handle
 * them. Unknown access offers nothing.
 */
export const BackgroundChecksAccessContext = createContext(false);

export function useHandlesBackgroundChecks() {
  return useContext(BackgroundChecksAccessContext);
}
