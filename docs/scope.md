# Local Scope assessments

[Microsoft Scope](https://microsoft.github.io/scope/) runs agents against fixed
repository snapshots. This setup adapts the assessment tools in Tearleads
(`2cda350734f39c5566045d59b116014db09258d6`) to Balebase, retaining this
repository's container worker. It measures whether an agent can discover the
setup, feature boundaries, and public client API it needs to work here.

A passing inspection task is evidence about that task and environment. It is
not an overall readiness score, proof of a clean install, or a successful code
change. Keep infrastructure failures separate from agent and repository findings.

## Install and start

The upstream source is pinned in `scripts/dev/scope.sh` and lives at
`~/.local/share/scope/source`. `SCOPE_SOURCE_DIR` overrides that location.
Install Node 22+, pnpm, Bun, and Docker Compose 2.24.4+ with a running engine.
Podman on macOS can supply the Docker API; use Docker Compose for its override
syntax. `scope:install` builds the CLI and installs it into `~/.local/bin`,
or `SCOPE_INSTALL_DIR`. It refuses a dirty or mismatched startup checkout.

Sign in to Claude Code and Codex on the host. This custom judge uses Codex's
saved ChatGPT login; it does not require Copilot or an OpenAI API key. The
upstream Copilot judge is disabled by default. The model and local ports are
pinned in `scripts/dev/scope/pins.json`; `CODEX_JUDGE_MODEL` can override the
judge model for a separate experiment.

```sh
bun run scope:install
bun run scope:up
bun run scope judge
```

The judge runs in the foreground; leave it running in a separate terminal.
The API listens on `127.0.0.1:3100`, the judge on `127.0.0.1:3202`, and the
local artifact emulator on `127.0.0.1:10102`. The container reaches the host
judge through `host.docker.internal`, supported by Docker Desktop and the
local macOS Podman machine. Set `SCOPE_JUDGE_URL` for another container-to-host
route; verify connectivity before submitting a scored task. The judge stays
bound to loopback. This host/container arrangement was exercised on macOS arm64.

Put local settings in ignored `.scope/local.env`, using shell syntax:

```sh
SCOPE_CLAUDE_CREDENTIALS_FILE="$HOME/.claude/.credentials.json"
```

This opt-in reads an existing JSON OAuth login at startup without copying its
token. For Keychain installations use `claude setup-token` and supply
`CLAUDE_CODE_OAUTH_TOKEN`, or provide `ANTHROPIC_API_KEY`. Explicit credentials
take precedence. Refresh expired credentials and rerun `scope:up`.
Model discovery requires an API key and is separately enabled with
`COMPOSE_PROFILES=anthropic-model-scanner`; the subscription worker can use its
default model without it.

For Podman, set `DOCKER_HOST` to the socket shown by `podman machine inspect`
and `DOCKER_SOCK=/run/podman/podman.sock` for a rootful machine. The package
commands load these settings; the plain installed `scope` binary does not.

The API uses anonymous local development mode. Local processes can submit
work using the worker's credentials. The worker also has the container-engine
socket, so it is intended for trusted tasks and source. Stop containers with
`bun run scope:down` and stop the foreground judge with Ctrl-C when idle.
Named volumes preserve projects, artifacts, and worker session evidence.
After a configuration-only change, `bun run scope:up --no-build` reuses the
existing images. Rebuild when the pinned upstream source changes.

## Run a baseline

```sh
bun run scope:register HEAD
bun run scope calibrate
bun run scope benchmark
bun run scope portal
```

Registration uploads committed source using `git archive`; it excludes local
edits, ignored credentials and installed dependencies. Registration IDs and
the exact source commit are saved in `.scope/config.json`. The archive omits
`.git`, so these tasks inspect files rather than testing bootstrap commands
that require Git metadata. Use a known ref to compare an earlier revision.

Calibration grades a known correct report and a deliberately incorrect report
against source evidence. It requires 4/4 and 1/4 passing criteria respectively;
only report existence should pass for the incorrect report. An unknown
criterion must fail. Calibration does not create benchmark dashboard runs.

The versioned `balebase-agent-readiness-v1` suite runs three cases sequentially:

1. Setup and verification discovery, including focused API tests and broader gates.
2. Issue creation from shared application code through contracts, authorization,
   persistence, activity, and offline synchronization.
3. Public API client onboarding, with a minimal example and host/credential assumptions.

Each agent writes `agent-readiness.md` with citations and a Friction section.
The criteria grade observable report contents, not unevidenced test execution.
Tasks prohibit reading benchmark definitions; the definitions remain public
in snapshots that contain them. This is an onboarding probe, not a hidden test.

`bun run scope benchmark 3` repeats each case three times. One trial per case
is a pilot; record the actual coder model from captured session evidence before
comparing runs. The judge model, CLI version, exact prompts, criteria, source
commit, tooling commit, run URLs, timings and verdicts are saved beneath
`.scope/benchmarks/`. Changing a criterion requires a new versioned ID;
registration refuses to silently overwrite definitions.

The optional portal runs in the foreground at `http://127.0.0.1:5102`. Logs,
full reports, archive snapshots and judge evidence remain in ignored `.scope/`.
Keep reviewed findings and fixes in a small repository report. Exclude old
unscored smoke runs from criterion comparisons: Scope marks those passed when
execution succeeds, even though no judge evaluated them.

## Evidence and other commands

The Codex judge runs in a read-only sandbox. It accepts artifact URLs only from
the configured local emulator, rejects archive links and escaping paths, and
requires one complete verdict for every criterion. Tool evidence is resolved
from the exact worker session named in Scope's run log. Reasoning content,
unrelated sessions and old judge verdicts are excluded. Missing evidence cannot
establish an execution claim.

```sh
bun run scope smoke
bun run scope run list
bun run scope run get -i <run-id>
bun run scope run download -i <run-id> -d .scope/results
bun run scope regrade .scope/benchmarks/<directory>/receipt.json
bun run scope:status
bun run test:scope
```

Regrading preserves original portal grades and writes a separate receipt.
A polling timeout can leave a request running; inspect it before resubmitting.
The offline tests exercise verdict completeness, dependency skips, run outcomes,
artifact boundaries, session identity and credential handling. Live evaluation
remains opt-in and is not part of CI.
