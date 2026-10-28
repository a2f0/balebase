# Agent readiness assessment

On 2026-10-26, a local [Scope](scope.md) assessment measured whether a coding
agent can find what it needs to work in this repository. It probes
documentation discoverability with three inspection tasks; it is not an
overall readiness score.

## Method

The versioned
[`balebase-agent-readiness-v1`](../scripts/dev/scope/benchmarks/agent-friendliness.json)
suite asks an agent to:

1. find the local setup and the smallest trustworthy API test path;
2. trace issue creation from the shared app through the API, authorization,
   persistence, activity history, and offline replay; and
3. write a minimal example for the public API client.

Each task has two criteria. The agent, Claude Code, could read source and write
only its report. Installs, tests, builds, credentials, and external services
were out of bounds. A separate Codex judge, calibrated against known-good and
known-bad reports, graded each report against the source. Each task ran once
on a baseline snapshot and once after the documentation fixes.

## Result

| Task | Baseline | After fixes |
| --- | --- | --- |
| Setup and verification discovery | 0/2 | 2/2 |
| Issue creation and offline architecture | 2/2 | 2/2 |
| Public API client onboarding | 1/2 | 1/2 |
| Total | 3/6 | 5/6 |

The remaining failure was an incorrect agent claim, not a documentation gap.
The client report said staging CORS configuration was unavailable and that
`fetch` needs a narrowing wrapper; neither is true. One trial per task cannot
separate the effect of the documentation from model variation.

## What changed

- CONTRIBUTING says that dependencies must be installed, that API tests run
  through the package command for its schema preload, and that the script
  tests use fixtures rather than live services or credentials.
- README explains when the local API refuses to start, and how that differs
  from running tests.
- [API client onboarding](api-client.md) covers public imports, a typed
  example, cookies and CORS, `fetch` outside a browser, and the shared and
  native wrappers.
- CONTRIBUTING links the issue and offline product documentation and names the
  general, audit, and offline entry points.
- The assessment tooling recovers from stale configuration, validates
  calibration output, and isolates worker transcripts.

No application change was needed. To measure again, follow the
[Scope guide](scope.md) and run `bun run scope benchmark 3` on a registered
commit; three trials per task give a less fragile baseline.
