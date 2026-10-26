# Agent readiness assessment

Assessed on 2026-10-26 using the local [Scope setup](scope.md). The initial
pilot passed **3 of 6 criteria**: architecture discovery was strong, while
setup prerequisites and client runtime assumptions were easy to misread.
After the documentation fixes, the comparison passed **5 of 6 criteria**.
The remaining failure concerns inaccurate agent claims, not a demonstrated
application defect.
This measures three inspection tasks, not an overall agent-readiness percentage.

## Method and provenance

Each reported task ran once per snapshot, with one Scope iteration and no
repair iteration.
The agent could inspect source and write only `agent-readiness.md`; installs,
tests, builds, application edits, credentials, and external services were
excluded.
A separate Codex judge checked the report against source and exact worker tool
records. The task prompts and six criteria were held fixed in
[`balebase-agent-readiness-v1`](../scripts/dev/scope/benchmarks/agent-friendliness.json).

| Setting | Value |
| --- | --- |
| Baseline source | `6c5c0bb4f57703d8e21d9711177db699bdcc3dd0` |
| Baseline tooling | `c5217e426b92c7df2204995a8c23243ba837d0fb` |
| Comparison source | `2d7e95b3c9af55861874e3437baf5630f53b0cae` |
| Comparison tooling | `2d7e95b3c9af55861874e3437baf5630f53b0cae` |
| Coding agent | Claude Code ACP, observed model `claude-sonnet-4-6` |
| Judge | Codex CLI `0.160.0`, `gpt-6-astra`, low reasoning effort |
| Environment | macOS arm64 host, Linux arm64 Podman worker; saved local logins |
| Scope source | `16544702d9dd4f0f5a7991fa4dbdf07a9247fedc` |
| Project | `4e3a28b1-99e6-4459-9d9a-25a49e12d8d1` |

Calibration accepted the known-correct fixture (4/4), rejected the deliberately
incorrect fixture (only report existence passed: 1/4), and rejected an unknown
criterion with HTTP 500. The scored smoke run scored 3/4: the agent omitted the
shared `packages/app` location already present in README. That was an agent
miss, not a missing-documentation finding. Older unscored smoke runs are excluded.

## Results

| Task | Baseline | Comparison | Baseline / comparison duration |
| --- | --- | --- | --- |
| Setup and verification discovery | 0/2 | 2/2 | 165.8 / 333.4 s |
| Issue creation and offline architecture | 2/2 | 2/2 | 307.8 / 317.7 s |
| Public API client onboarding | 1/2 | 1/2 | 294.0 / 166.5 s |
| Total | 3/6 | 5/6 | 767.6 / 817.6 s |

The shipping branch also incorporates the concurrent README website-link
change from `40f44885ca501698d4d901d3588748d15cbfd960` and shipping-tool update
`6e1946e1da3bc82ce71874d81f6c2d0de6ecfa56`, plus finance sync update
`bff5fcdfbbc4b73773df10eafdfb2534126484fa`; the measured snapshots remain fixed.
Later assessment hardening and the final documentation clarifications below
are shipping changes, not additional scored trials.

Durations are Scope worker durations, including grading. They are descriptive;
one trial cannot establish a performance improvement.

The setup report found the focused API command and its contract-validation
preload, but omitted dependency installation. It also incorrectly claimed
`test:staging`, `test:env`, and `test:scope` require live services or
credentials.
The judge failed both setup criteria for these omissions and false
prerequisites.

The architecture report traced the shared screen, public client, validators,
Hono route, organization authorization, database write, activity triggers, and
offline queue/replay. Both criteria passed. A passing report still contained a
caveat: it overstated production response validation. `respond.ts` collects
schema mismatches only when test collection is enabled.

The client report used correct public imports and `session.me()` signatures.
It omitted the lack of a browser session cookie jar in default server-side
fetch and mixed verified observations with assumptions in its Friction section.
For example, `private: true` prevents package publication; it does not itself
prevent module resolution. The runtime-environment criterion failed.

In the comparison, setup included installation and correctly distinguished
fixture tests from live services. Client onboarding explained the missing
non-browser cookie jar and the shared/native wrappers, but its Friction section
still claimed staging CORS configuration was unavailable and that ordinary
`fetch` needs a narrowing wrapper. Both claims are false: staging configuration
is in `scripts/deploy/createStagingConfigs.ts`, and standard `fetch` is type
compatible with `ApiClientOptions.fetch`. We verified that assignment with the
package TypeScript check. The final client guide adds these references and
clarifications; those last additions have not been rescored. The criterion
remains failed in the report rather than rewriting the original verdict.

## Findings and fixes

| Finding | Evidence and disposition |
| --- | --- |
| Verification prerequisites were easy to misinterpret | `scripts/testing/testDeployStaging.sh`, `testCloudflareEnv.sh`, and `scope.test.ts` use fixtures/stubs. Clarified this in CONTRIBUTING, alongside dependency installation and package-local API test preloads. The claim that live credentials were required was an agent error. |
| Local startup failure was not explicit | `scripts/dev/devApi.sh` and `scripts/lib/cloudflareEnv.sh` require `.secrets/prod/app.env` and a nonempty auth secret. README now explains when startup stops and distinguishes tests from the dev server. |
| No concise public-client onboarding guide | Added [API client onboarding](api-client.md): public imports, a typed example, cookie/CORS requirements, non-browser fetch limits, and shared/native host boundaries. The example was type-checked using the package's check command. |
| Issue entrypoints required source archaeology | CONTRIBUTING now links existing issue/offline product documentation and names general, audit-specific, and offline mutation entrypoints. |
| Assessment tooling needed stronger failure handling | Fixed stale configuration blocking shutdown/re-registration, expanded boundary tests, validated calibration output, and isolated persistent worker project transcripts from user settings. Independent review also prompted an archive-library update and clearer host read-access limitations. |

No application behavior change was justified by these probes. The architecture
report's proposed offline timestamp and transaction-target changes are product
choices, not demonstrated defects. Transaction issues are already excluded from
offline scope in [Offline work](product.md#offline-work). The report also missed
existing documentation that the Ruby bundle is required for both checks and
tests.

## Evidence and reproducibility

Baseline runs:

- Setup: `2fb00017-1798-40a3-a986-60cc2be38468`
- Architecture: `67c51bc9-522f-476e-b995-0591b099599c`
- Client onboarding: `1ba98ff5-0d47-4ce7-b66c-d5a9435f4516`
- Scored smoke: `38bb9192-e34f-40ae-bfc3-3897dfbc7947`

Comparison runs:

- Setup: `e3802350-0b47-4de6-81da-e01a6602ad04`
- Architecture: `8308f7e7-ff9b-419d-b277-99237a9c59eb`
- Client onboarding: `18e8f4ab-d485-4256-a833-60573f7c6f32`

Comparison receipt:
`.scope/benchmarks/1793021044334-balebase-agent-readiness-v1/receipt.json`.

Baseline receipt:
`.scope/benchmarks/1793018842660-balebase-agent-readiness-v1/receipt.json`.
Baseline calibration: `.scope/calibration/run-IjNa4i/receipt.json`.
Comparison calibration: `.scope/calibration/run-bTVDJS/receipt.json`.
The excluded intermediate comparison retained calibration
`.scope/calibration/run-FWDCRD/receipt.json`.
The baseline source archive revision is
`39d5de3e-5b8a-4b18-9c43-e6f857477171`; the comparison revision is
`60ada469-4f65-4be9-8807-51ac9f9dc76c`.

Private receipts contain exact prompts, criteria, verdicts, timings, snapshots,
and run links. Full reports and filtered tool evidence remain in
`.scope/judge/evaluations/`. Inspect a saved request with
`bun run scope run get -i <run-id>` or open its `/runs/<run-id>` page in the
local portal at `http://127.0.0.1:5102`.

All 834 returned baseline source files and all 862 returned comparison source
files matched their registered archives; the only addition in each snapshot
was the requested report. Scope excludes the two
`.vscode` files from returned snapshots. Tool evidence showed inspection
commands and one report write per task, with no tests/builds/installs or deployments.
Client discovery included two unsuccessful guessed entrypoint paths in the
baseline and one missing-file read in the comparison. These are retained in
the evidence rather than treated as infrastructure errors. No direct reads of
benchmark definition files were observed. The definitions were present in the
comparison archive, so this is not a hidden-test evaluation.

## Validation and limits

Repository validation includes `bun run check`, `bun run test`, all three
browser suites, and `bun run build`. The browser suites passed 23, 1, and 36
tests respectively. Local reruns encountered the offline-browser test's
30-second timeout and a website browser-cleanup hook's 5-second timeout.
Both suites passed unchanged on retry; no timeout was increased and no test
scope was reduced. Builds retained existing Vite large-chunk warnings.
These coordinator-run checks verify the shipped changes; the assessment agents
did not run them. The offline Scope regression suite passed 47 tests, including
configuration recovery, credential filtering, criterion dependencies/gates,
verdict completeness, real archive extraction, actual judge invocation flags,
local HTTP request restrictions, and stock macOS Bash compatibility.

One calibration attempt and local validation were interrupted by host disk
exhaustion. Unused Scope VM images were reclaimed and free VM space was trimmed;
those infrastructure failures are excluded from the scores. An intermediate
comparison also exposed a root-owned Claude state directory: setup passed 2/2
using file reads, but shell calls failed. That batch was stopped during the
architecture task and excluded. The worker now uses writable temporary state
and a separate persistent project-transcript volume. Permissions and the
container-to-judge route were verified before restarting all three tasks.
The local judge was recalibrated before the corrected comparison. The judge's
read-only sandbox prevents writes but does not confine reads to its job directory;
this host setup is for
trusted source and tasks, as described in the Scope guide.

A single trial per task cannot separate documentation effects from model
variation. The coder uses a provider-default model, so compare the model recorded
in worker evidence, not just the worker label. The source archive omits Git
metadata and dependencies; this did not test a clean bootstrap, a successful
implementation, live authentication, deployment, or a native device build.
Repeat `bun run scope benchmark 3` on a registered commit for a less fragile
inspection baseline; use separate implementation/bootstrap tasks to assess those
other capabilities. Results describe the pinned snapshots above; later changes
merged into `main` are not implicitly assessed by these runs.
