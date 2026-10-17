import { readFileSync } from "node:fs";
import conventionalConfig from "@commitlint/config-conventional";

// agent-tool checks PR titles and squash subjects against this same policy.
const { subject } = JSON.parse(
  readFileSync(new URL("./agent-tool.json", import.meta.url), "utf8"),
) as { subject: { maxLength: number; types: string[] } };

const conventionalTypes = conventionalConfig.rules["type-enum"][2];
const expectedTypes = new Set([...conventionalTypes, "cleanup"]);
if (
  expectedTypes.size !== subject.types.length ||
  subject.types.some((type) => !expectedTypes.has(type))
) {
  throw new Error("The agent-tool.json commit types are out of sync.");
}

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", subject.types],
    "header-max-length": [2, "always", subject.maxLength],
  },
};
