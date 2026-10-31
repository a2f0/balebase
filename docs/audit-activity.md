# Audit activity

Activity is the shared history of consequential changes across Balebase. The
checklist Audits feature is one producer alongside equipment, projects, issues,
organization membership (roles, invitations, joining, leaving and removal),
organization renames, deletion and restoration, group access, members'
two-factor requirements, API keys, and transaction annotations, categories,
and bank connection sync settings.
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
workspace issues, equipment, projects, the organization, people, invitations,
groups, API keys, transactions, and bank connections. Audit and transaction
filters include issues attached to those roots; workspace issues are
standalone issues. Transaction and bank connection
activity requires Finance capability even when a caller supplies the filter
directly. Group events, invitation events (they name invited addresses),
two-factor requirement changes, and the organization's deletion and
restoration are visible only to organization owners and admins, as group
details, pending invitations and member security settings already are.
Everyone in the organization sees people joining, leaving, being removed or
changing role, and organization renames. Root admins read the organization's
own history (renames, deletion and restoration) on its admin detail page,
including while it is deleted. The MCP `list_activity` tool accepts the same optional
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

## Organization membership

Better Auth's organization endpoints carry the request's actor into the write
they make (`auth/organizationActivity.ts`), so the triggers of migrations 0057
and 0080 record each change atomically with it: role changes, invitations
sent, canceled (including the cancel a re-invite makes) or declined, a person
joining by invitation (actor: the person; details: the role and the inviter),
and organization renames, URL name and logo changes. Removing a member and
leaving run as one batch (`organizations/memberRemoval.ts`) that records the
membership's end with its role and the API keys it stops, each group the
person loses as a group update, and each equipment item returned to
unassigned, all attributed to the remover (or to the person leaving), then
deletes the membership. That batch re-checks that the remover still owns or
administers the organization and never removes the last owner. Deleting an
organization (by an owner or a root admin, `details.via`) and restoring it
record events in the same batch as the change; the restoration keeps who had
deleted it, which the organization row then clears. Rejected requests and
saves that change nothing record nothing. A membership deleted with no request
behind it, as when an account is purged, has no actor to record until the
shared model gains a system actor; equipment is still unassigned then.

## Group access

Groups grant capabilities such as Finance. Their creation, deletion, renames,
and each save's granted and revoked members and capabilities are recorded
against the group's stored state in the same batch as the write; a save that
changes nothing records nothing, and deletion keeps the group's history until
the organization is purged. Better Auth's team endpoints that would change
groups (`create-team`, `update-team`, `remove-team`, `add-team-member`,
`remove-team-member`) are disabled, and invitations cannot carry a group
(older ones lose theirs on acceptance), so `/api/organization-groups` is the
only writer apart from member removal, which records each group the person
loses. Group and two-factor requirement writes re-check in the transaction
that the actor is still an owner or admin.

## Reviewing coverage

For implementation changes, test successful event creation, actor attribution,
relevant before/after values, no-op or failure behavior, and authorized reads.
Use rollback and retry tests when those paths affect correctness. Existing
examples live in `packages/api/src`: `audits/auditActivity.test.ts`,
`equipment/equipment.test.ts`, `projects/projects.test.ts`, `auth/apiKeys.test.ts`,
`auth/organizationRoleActivity.test.ts`,
`organizations/membershipActivity.test.ts`,
`organizations/accessActivity.test.ts`, and `issues/issues.test.ts`.

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
