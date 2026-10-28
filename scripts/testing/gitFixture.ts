/**
 * The environment for Git commands in a fixture repository. Git exports
 * GIT_DIR, GIT_INDEX_FILE, and similar variables to hooks; a fixture that
 * inherits them operates on the repository running the hook, so its `git init`
 * marks that repository bare and its commits land on the checked-out branch.
 */
export function gitFixtureEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}
