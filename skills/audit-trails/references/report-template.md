# Audit trail coverage report

Record repository, full commit SHA, date, dirty-path treatment, scope,
exclusions, and whether this is a complete or partial review of that scope.

## Coverage

| Workflow | Mutation and event mechanisms checked | Reader checked | Status |
| --- | --- | --- | --- |

Use covered, gap, partial, or unchecked. Covered means the stated behavior
was traced or tested; it does not certify every concurrency or failure path.

## Ranked findings

| ID | Finding | Impact | Evidence | Existing issue |
| --- | --- | --- | --- | --- |

For each finding:

- **Trigger and result:** a concrete action and the missing or misleading
  history it leaves. Explain what attribution or reconstruction is lost.
- **Evidence:** source links pinned to the audited commit and relevant line
  numbers; trace the mutation, triggers/helpers, and readers. Include probe
  commands, outcomes, and artifact paths for Reproduced findings.
- **Existing coverage:** separate histories, current-state actor fields,
  retention policy, and why they do or do not satisfy this case.
- **Recommendation:** action/resource/actor/details and transactional behavior;
  required reader permissions and visibility; no speculative historical data.
- **Acceptance criteria:** observable success, no-op/failure, attribution,
  isolation, and retry/retention behavior appropriate to the finding.

## Unverified leads and remaining scope

Separate incomplete traces and unavailable tests from ranked findings. Record
the next verification step and any unchecked entrypoints. A clean source trace
does not prove deployed migrations, production data, or runtime behavior.

## Suggested implementation order

Order by impact and dependencies. State which changes, if any, were made in
the current task separately from the audit's findings.
