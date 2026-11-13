import { createContext, useContext } from "react";

/** Unknown workspace access must never expose a new paid action. */
export const PaidFeaturesContext = createContext(false);

export function usePaidFeaturesEnabled() {
  return useContext(PaidFeaturesContext);
}
