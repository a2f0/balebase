# Audit activity

Activity is the shared history of consequential changes across Balebase. The
checklist Audits feature is one producer alongside equipment, projects, issues,
organization roles, group access, members' two-factor requirements, API keys,
and transaction annotations, categories, and bank connection sync settings.
The workspace page is `/activity`; individual records can expose the same
events in their own history. Contract signing also has a
separate history. Coverage is incremental: an empty shared feed does not prove
no changes occurred.

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
actor model, never a fabricated human identity.

## Reading and retaining history

`GET /api/activity` reads the active organization's events newest first, with
cursor pagination. Its optional `resourceType` filter selects the root type
before pagination. The Activity page offers all resources, audits, forms,
workspace issues, equipment, projects, people, groups, API keys, transactions,
and bank connections. Audit and transaction filters include issues attached to those
roots; workspace issues are standalone issues. Transaction and bank connection
activity requires Finance capability even when a caller supplies the filter
directly. Group events and two-factor requirement changes are visible only to
organization owners and admins, as group details and member security settings
already are. The MCP `list_activity` tool accepts the same optional
`resourceType`; keep that filter when passing the next cursor.

Resource history routes authorize the resource before using `findActivity`.
Shared global form history only exposes published versions to organization
members. Adding a producer with restricted details also requires reviewing
the shared feed's reader permissions, labels, and navigation.

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

## Platform and account history

Some histories are not organization activity:

- `user_role_events` records platform role changes: revocations from the Users
  page with the acting admin, and `auth:set-role` changes with the operator who
  ran the script (`actor_kind = 'operator'`, no user ID). D1 operators read it.
- `user_deletion_events` records account deletion requests and cancellations.
- `maintenance_requests` records every manual maintenance request, including
  one that joins an active run, with the requester's snapshot. It outlives the
  30-day job history and the requester's account. Each request also logs a line
  on its run, and the run keeps the first requester's name and email.
- `user_security_events` records a person's own two-factor and password
  changes by trigger. The person reads it under Account settings → Security;
  root admins read it in D1.

Better Auth's admin endpoints that would change another person's account or
act as them (`set-user-password`, `ban-user`, `unban-user`,
`revoke-user-session(s)`, `remove-user`, `impersonate-user`,
`stop-impersonating`) are disabled, as are its role endpoints; offer such an
action only as a guarded, recorded `/api/admin/users` route.

## Reviewing coverage

For implementation changes, test successful event creation, actor attribution,
relevant before/after values, no-op or failure behavior, and authorized reads.
Use rollback and retry tests when those paths affect correctness. Existing
examples live in `packages/api/src`: `audits/auditActivity.test.ts`,
`equipment/equipment.test.ts`, `projects/projects.test.ts`, `auth/apiKeys.test.ts`,
`auth/organizationRoleActivity.test.ts`,
`organizations/accessActivity.test.ts`, `issues/issues.test.ts`,
`jobs/maintenanceRequests.test.ts`, `admin/setUserRole.test.ts`, and
`users/securityEvents.test.ts`.

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
