import { afterEach } from "bun:test";
import { collectContractMismatches } from "./respond";

// Every response a test receives through `respond` must match its route's
// contract, so the client's types describe what the API really sends.
const mismatches: string[] = [];
collectContractMismatches(mismatches);

afterEach(() => {
  if (mismatches.length)
    throw new Error(
      `The API broke its contract:\n${mismatches.splice(0).join("\n")}`,
    );
});
