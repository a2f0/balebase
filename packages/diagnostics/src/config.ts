const diagnosticTargets = ["web", "android", "ios", "api"] as const;

export type DiagnosticTarget = (typeof diagnosticTargets)[number];
export type DiagnosticSource =
  | "boundary"
  | "uncaught-react"
  | "unhandled-error"
  | "unhandled-rejection"
  | "request-error"
  | "email-error"
  | "scheduled-error"
  | "job-error";

export interface SentryBuild {
  dsn: string;
  environment: "staging" | "production";
  release: string;
  target: DiagnosticTarget;
}

export interface SentryConfig extends SentryBuild {
  origin: string;
  paths: ReadonlySet<string>;
}

export function isHostedSentryDsn(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^[a-f0-9]{32}$/u.test(url.username) &&
      !url.password &&
      /^o\d+\.ingest(?:\.(?:us|de))?\.sentry\.io$/u.test(url.hostname) &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/\d+$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isSentryBuild(value: unknown): value is SentryBuild {
  if (!value || typeof value !== "object") return false;
  const { dsn, environment, release, target } = value as SentryBuild;
  return (
    typeof dsn === "string" &&
    isHostedSentryDsn(dsn) &&
    (environment === "staging" || environment === "production") &&
    diagnosticTargets.includes(target) &&
    typeof release === "string" &&
    new RegExp(`^balebase-${target}@[a-f0-9]{40}$`, "u").test(release)
  );
}

export function browserConfig(
  build: SentryBuild,
  manifest: unknown,
  origin: string,
): SentryConfig | undefined {
  if (
    !isSentryBuild(build) ||
    build.target === "api" ||
    !manifest ||
    typeof manifest !== "object"
  )
    return undefined;
  const { release, environment, target, paths } = manifest as Record<
    string,
    unknown
  >;
  if (
    release !== build.release ||
    environment !== build.environment ||
    target !== build.target ||
    !Array.isArray(paths) ||
    !paths.length
  )
    return undefined;
  if (
    !paths.every(
      (path: unknown) =>
        typeof path === "string" &&
        /^\/assets\/[a-zA-Z0-9_.-]+\.js$/u.test(path),
    )
  )
    return undefined;
  return { ...build, origin, paths: new Set(paths as string[]) };
}
