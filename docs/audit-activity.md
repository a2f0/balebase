# Audit activity

Activity is the shared history of consequential changes across Balebase. The
checklist Audits feature is one producer alongside equipment, projects, issues,
organization roles, group access, members' two-factor requirements, API keys,
transaction annotations, categories, and bank connection sync settings,
library files and folders, inbox email moves and links, and businesses.
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
bank connections, library files, library folders, inbox email, and businesses.
Audit and transaction filters include issues attached to those roots; workspace
issues are standalone issues. Transaction and bank connection activity requires
Finance capability even when a caller supplies the filter directly, including
emails linked to a transaction. Group events and two-factor requirement changes
are visible only to organization owners and admins, as group details and member
security settings already are. The MCP `list_activity` tool accepts the same
optional `resourceType`; keep that filter when passing the next cursor.

Resource history routes authorize the resource before using `findActivity`.
Shared global form history only exposes published versions to organization
members. Adding a producer with restricted details also requires reviewing
the shared feed's reader permissions, labels, and navigation.

History follows the resource's documented retention. It is not an immutable
compliance ledger. Purging an organization removes its activity; purging an
audit run or form removes that root's history. Historical imports must be
marked as such and contain only facts actually retained. Do not reconstruct
unknown editors, previous values, or timestamps from current state.

## Library, inbox, and businesses

Uploading, moving, and permanently deleting a library file records an event on
the file (`library_file`) naming its filename, content type, size, and folder,
never its contents or storage key. Creating, renaming, and deleting a folder
records one on the folder (`library_folder`); a deletion counts the files it
returns to the library root and the email links it removes. Moving a file to
the folder it is in, or renaming a folder to its current name, records nothing.
A file's deletion commits with its event and queues its bytes for the
deleted-object cleanup, which retries if removing them fails.

Moving an email to Archive or Trash, and restoring it, records an event on the
email (`inbound_email`), labelled with its subject and naming only its sender
and the folder it left, never its body or attachments; restoring no longer
erases who trashed it. Linking an email to a folder, equipment, or a
transaction, and unlinking it, records an event on that record with the email as
the subject, so a transaction's links need Finance access wherever they are
read. A folder or equipment deletion counts or drops its links without one event
per link, and Plaid removing a transaction removes its links, and its history,
without an event. Inbound mail is a provider action with no user actor: the
stored message and its raw `.eml` are its record.

Creating, editing, and deleting a business records an event on the business
(`business`). Edits list each changed field with its old and new value; a save
that changes nothing, a duplicate EIN or DUNS number, and a save racing another
change record nothing. Every member can read the feed, so events show only the
last four digits of an EIN or DUNS number.

Folders, emails, and businesses show their own history. An email's history also
lists its links, recorded on the linked records.

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

## Reviewing coverage

For implementation changes, test successful event creation, actor attribution,
relevant before/after values, no-op or failure behavior, and authorized reads.
Use rollback and retry tests when those paths affect correctness. Existing
examples live in `packages/api/src`: `audits/auditActivity.test.ts`,
`equipment/equipment.test.ts`, `projects/projects.test.ts`, `auth/apiKeys.test.ts`,
`auth/organizationRoleActivity.test.ts`,
`organizations/accessActivity.test.ts`, `issues/issues.test.ts`,
`library/libraryActivity.test.ts`, `inbox/inboxActivity.test.ts`, and
`businesses/businessActivity.test.ts`.

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
