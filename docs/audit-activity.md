# Audit activity

Activity is the shared history of consequential changes across Balebase. The
checklist Audits feature is one producer alongside equipment, projects, issues,
organization roles, group access, members' two-factor requirements, API keys,
transaction annotations, categories, and bank connection sync settings,
contracts and contract templates, and the forms and checks requested of
people. The workspace page is `/activity`; individual records can expose the
same events in their own history. Contract signing also has a separate
history (see [Contracts](#contracts)). Coverage is incremental: an empty shared
feed does not prove no changes occurred.

## Recording a change

For a new mutation, decide which durable history records it. Access changes,
business record changes, deletions and restorations, and consequential provider
updates should be attributable. If a change needs no event, explain the reason
in its PR. Use the existing shared event model when its permissions and
retention fit the resource; document any separate history and its readers.

An event identifies:

- The owning organization, or an explicitly authorized global resource.
- A stable action, such as `equipment.assigned`.
- The root resource and its label at the time of the change.
- The subject that changed, which can differ from the root: an issue or image
  may belong to an audit run or a transaction.
- The actor's identity snapshot and occurrence time. API-key requests also
  retain the key name and REST/MCP channel.
- Allowlisted details sufficient to understand the change, including old and
  new values when useful. Keep secrets and sensitive document contents out.

Use a database trigger or `activityStatement` in the same transaction as the
mutation. Conditional writes must emit an event only when the intended change
succeeds; stale saves, denied requests, and no-ops must not claim a change.
Use `activityBatch` with the request's API key so trigger and explicit events
receive the same attribution. Audit failures must roll back the related change.
Provider retries need a stable deduplication boundary. The current shared model
requires a user actor; extending it to system/provider work needs an explicit
actor model, never a fabricated human identity. Until then, maintenance jobs
such as the discarded global form purge record no events: the projects that
lose a purged form show no removal, and the job run keeps only its count.

## Reading and retaining history

`GET /api/activity` reads the active organization's events newest first, with
cursor pagination. Its optional `resourceType` filter selects the root type
before pagination. The Activity page offers all resources, audits, forms,
workspace issues, equipment, projects, people, groups, API keys, transactions,
bank connections, contracts, contract templates, and requested forms and
checks. Audit and transaction filters include issues attached to those
roots; workspace issues are standalone issues. Transaction and bank connection
activity requires Finance capability even when a caller supplies the filter
directly. Group events, two-factor requirement changes, and requested forms and
checks (`employee_requirement`) are visible only to organization owners and
admins, as group details, member security settings, and employee records
already are. The MCP `list_activity` tool accepts the same optional
`resourceType`; keep that filter when passing the next cursor.

Resource history routes authorize the resource before using `findActivity`.
Shared global form history only exposes published versions to organization
members. Form events name the version they saved: creation (with the global
form a copy came from and the published version it started from), saved
versions, publication,
unpublication, discards, and restores. Organizations therefore see a global
form's publications but never its unpublications, discards, or restores.
Adding a producer with restricted details also requires reviewing the shared
feed's reader permissions, labels, and navigation.

History follows the resource's documented retention. It is not an immutable
compliance ledger. Purging an organization removes its activity; purging an
audit run or form removes that root's history. Historical imports must be
marked as such and contain only facts actually retained. Do not reconstruct
unknown editors, previous values, or timestamps from current state.

## Group access

Groups grant capabilities such as Finance. Their creation, deletion, renames,
and each save's granted and revoked members and capabilities are recorded
against the group's stored state in the same batch as the write; a save that
changes nothing records nothing, and deletion keeps the group's history until
the organization is purged. Better Auth's team endpoints that would change
groups (`create-team`, `update-team`, `remove-team`, `add-team-member`,
`remove-team-member`) are disabled, and invitations cannot carry a group
(older ones lose theirs on acceptance), so `/api/organization-groups` is the
only writer. Group and two-factor requirement writes re-check in the transaction
that the actor is still an owner or admin.

## Contracts

Each contract keeps its own events (`contract_events`): creation, sending,
signing-link emails and reminders, views, signatures and declines with the
signer's IP and user agent, voids, completion, and failed deliveries. The
contract page and the certificate of completion read them, and they go with the
contract when it is deleted. An event a person made through an API key also
keeps the key's name and REST/MCP channel, which both readers show. Scheduled
reminders, completion, and delivery records have no actor. Sends, voids, and
completions record their event in the same transaction as the change.

The shared activity records `contract.created`, `contract.sent` (with the
signer count, signing order, and due date that went out), `contract.voided`,
and `contract.deleted`, which snapshots the status, document hashes, signer
count, and template so a deleted agreement still leaves a trace until the
organization is purged. Signer emails, IPs, and signatures stay out of it.
Draft autosaves are not recorded; `contract.sent` captures the configuration
that was sent. Deleting a contract template records
`contract_template.deleted` with its current version and version count; while
a template exists, its immutable versions name who saved each one.

Requested forms and checks record assignment, due date and status changes
(old and new values; a status set by hand is always a manager's), deletion
(with the number of signed screening authorizations removed with it), each
document upload (revision, and whether the person or a manager uploaded it),
and background-check requests (work location, and the report a re-request
supersedes). Manager writes re-check in the transaction that the actor is
still an owner or admin. Details never hold filenames, screening results, or
consent contents. The person's signed authorizations keep their own record
(`employee_screening_consents`). Checkr's report status and result changes
are not recorded yet: they come from the provider and need a system actor.

## Reviewing coverage

For implementation changes, test successful event creation, actor attribution,
relevant before/after values, no-op or failure behavior, and authorized reads.
Use rollback and retry tests when those paths affect correctness. Existing
examples live in `packages/api/src`: `audits/auditActivity.test.ts`,
`equipment/equipment.test.ts`, `projects/projects.test.ts`, `auth/apiKeys.test.ts`,
`auth/organizationRoleActivity.test.ts`,
`organizations/accessActivity.test.ts`, `issues/issues.test.ts`,
`contracts/contractActivity.test.ts`, and
`employeeForms/requirementActivity.test.ts`.

The repository-owned [audit-trails skill](../skills/audit-trails/SKILL.md)
reviews mutations, triggers, separate histories, readers, and retention, then
produces a ranked report or requested GitHub issue. Its source lives in
`skills/` because `.agents/skills` and `.claude/skills` are generated by the
pinned agent tool. Install this source in a personal skill directory for
Codex or Claude Code; keep both installations pointed at the same directory.
Invoke `$audit-trails` in Codex or `/audit-trails` in Claude Code, with an
optional focus such as access changes or finance. Saved reports record their
revision and remaining scope so later runs can resume without claiming stale
findings are current.
