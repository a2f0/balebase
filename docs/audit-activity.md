# Audit activity

Activity is the shared history of consequential changes across Balebase. The
checklist Audits feature is one producer alongside equipment, projects, issues,
organization membership (roles, invitations, joining, leaving and removal),
organization renames, deletion and restoration, group access, members'
two-factor requirements, API keys, transaction annotations and categories,
bank connections (connecting, sync requests and settings, disconnecting, and
deleting imported data), expense categories, Pro checkout starts, library
files and folders, inbox email moves and links, businesses, contracts and
contract templates, the forms and checks requested of people, and maintenance
jobs that purge records. The
workspace page is `/activity`; individual records can expose the same events
in their own history. Contract signing also has a separate history (see
[Contracts](#contracts)). Coverage is incremental: an empty shared feed does
not prove no changes occurred.

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
- The actor and occurrence time. A person (`actor_type = 'user'`) is kept as
  an identity snapshot; API-key requests also retain the key name and REST/MCP
  channel. Work no person did names its source instead (see below).
- Allowlisted details sufficient to understand the change, including old and
  new values when useful. Keep secrets and sensitive document contents out.

Use a database trigger or `activityStatement` in the same transaction as the
mutation. Conditional writes must emit an event only when the intended change
succeeds; stale saves, denied requests, and no-ops must not claim a change.
Use `activityBatch` with the request's API key so trigger and explicit events
receive the same attribution. Audit failures must roll back the related change.
Never fabricate a human identity for work no person did. Events record an
explicit actor type (migration `0085_record_system_activity.sql`):

- `user`: a person; `actor_user_id` and the name and email snapshot are set.
  A CHECK constraint keeps every user event tied to a user.
- `system`: Balebase's own maintenance. `actor_source` is the maintenance job's
  ID (such as `purgeDiscardedAuditForms`); readers show "Balebase maintenance".
- `provider`: a provider's change. `actor_source` is the provider (`stripe`,
  `plaid`, or `checkr`); readers show its name.

System and provider events have no user ID and an empty email, and never name
an API key. `causation_type` and `causation_id` say what caused them: the job
run (`job_run`) or a provider's event ID (such as `stripe_event`). They are the
deduplication boundary for provider retries and redelivered runs: a unique
index allows one event per cause, action, root, and subject, and a redelivery
records nothing new. Record them with `systemActivityStatement` (one event,
like `activityStatement`) or `systemActivityRowsStatement` (one event per row
of a SELECT that snapshots the affected records) from `shared/activity.ts`, in
the same batch as the change and under the same guard, with
`maintenanceActor(jobId, runId)` or a provider actor. A purge must record its
events before the guarded `DELETE` so they can snapshot what it removes, and
keep each event's subject distinct per deletion so later batches of the same
run are not taken for redeliveries.

Maintenance jobs record their changes this way: the purges of accounts and
organizations (as platform purge history, below), the Free-plan retention purge
(`organization.audit_runs_purged` on the organization, with the number of runs
removed), the discarded global form purge (`project.form_disabled` with
`reason: form_purged` on each project that had the form), and the trashed email
purge (below). Stripe-driven subscription and seat changes, Plaid-driven
connection status changes, and Checkr report changes still stay in their
current-state columns, the provider's own history, and job runs until their
producers adopt the provider actor.

## Reading and retaining history

`GET /api/activity` reads the active organization's events newest first, with
cursor pagination. Its optional `resourceType` filter selects the root type
before pagination. The Activity page offers all resources, audits, forms,
workspace issues, equipment, projects, the organization, people, invitations,
groups, API keys, transactions, bank connections, expense categories, billing,
library files, library folders, inbox email, businesses, contracts, contract
templates, and requested forms and checks. Audit and transaction filters
include issues attached to those roots; workspace issues are standalone issues.
Transaction, bank connection, and expense category activity requires Finance
capability even when a caller supplies the filter directly, including emails
linked to a transaction. Group events, invitation events (they name invited
addresses), two-factor requirement changes, billing events, the organization's
deletion and restoration, and requested forms and checks
(`employee_requirement`) are visible only to organization owners and admins,
as group details, pending invitations, member security settings, billing
management, and employee records already are. Everyone in the organization
sees people joining, leaving, being removed or changing role, and organization
renames. Root admins read the organization's own history (renames, deletion
and restoration) on its admin detail page, including while it is deleted. The
MCP `list_activity` tool accepts the same optional `resourceType`; keep that
filter when passing the next cursor.

Resource history routes authorize the resource before using `findActivity`.
A contract template's history (`GET /api/contracts/templates/:id/activity`,
MCP `list_contract_template_activity`) is on its page while it exists. A
requested form or check's history (`GET /api/employee-forms/:id/activity`,
MCP `list_employee_requirement_activity`) is on the manager's request page and
readable only by organization owners and admins, never by the person it was
requested from.
A bank connection's history (`GET /api/finance/connections/:id/activity`, MCP
`list_finance_connection_activity`) stays readable after it is disconnected.
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
audit run or form removes that root's history, though the Free-plan retention
purge leaves its count on the organization and the form purge leaves each
affected project's removal. Deleting a disconnected bank
connection's imported data removes that connection's and its transactions'
history, but keeps one `finance.connection_data_deleted` event naming who
deleted it and how many accounts, transactions, and annotations went. Historical
imports must be marked as such and contain only facts actually retained. Do not
reconstruct unknown editors, previous values, or timestamps from current state.

## Organization membership

Better Auth's organization endpoints carry the request's actor into the write
they make (`auth/organizationActivity.ts`), so the triggers of migrations 0057
and 0083 record each change atomically with it: role changes, invitations
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
behind it, as when an account is purged, is not recorded on the organization
yet; equipment is still unassigned then.

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
per link. The **Purge trashed email** job (`purgeTrashedEmails`, run on request
from **Root Admin → Jobs**; it replaced the `emails:purge` operator script)
permanently deletes email that has been in Trash for 30 days. In the same
transaction it records `inbox.email_purged` on the email, by the job, counting
its attachments and folder and equipment links but naming no transaction, and
`inbox.email_unlinked` (`reason: email_purged`) on each record a legacy trashed
email was still linked to. Its raw message and attachments are removed by the
deleted-file cleanup after that commits. When Plaid removes a transaction, its
links are hidden with it, and
kept, without an event. Inbound mail is a provider action with no user actor:
the stored message and its raw `.eml` are its record.

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
only writer apart from member removal, which records each group the person
loses. Group and two-factor requirement writes re-check in the transaction
that the actor is still an owner or admin.

## Contracts

Each contract keeps its own events (`contract_events`): creation, sending,
signing-link emails and reminders, views, signatures and declines with the
signer's IP and user agent, voids, completion, and failed deliveries. The
contract page and the certificate of completion read them, and they go with the
contract when it is deleted. An event a person made through an API key also
keeps the key's name and REST/MCP channel, which both readers show. A manual
reminder names its sender, and so does its failed delivery; scheduled
reminders (and manual ones recorded before senders were), completion, and
other delivery records have no actor. Sends, voids, completions, and a
signer's first view record their event in the same transaction as the change.
An email cannot share a transaction, so its `notified` or `reminded` event
follows the send; a failed insert is retried once and logged, and never
recorded as a failed delivery.

The shared activity records `contract.created`, `contract.sent` (with the
signer count, signing order, and due date that went out), `contract.voided`,
and `contract.deleted`, which snapshots the status, document hashes, signer
and signed counts, when it was declined, and template so a deleted agreement
still leaves a trace until the organization is purged. Signer emails, IPs,
signatures, and decline reasons stay out of it. A decline is the signer's and
a completion the system's, so neither is a shared event until the shared model
has a non-user actor; their `contract_events` and the deletion snapshot record
them. Draft autosaves are not recorded; `contract.sent` captures the
configuration that was sent.

Uploading a contract template records `contract_template.created` (name,
page count, and document hash), and each saved version records
`contract_template.version_saved` (version, the version it was edited from,
the previous name, role and field counts, signing order, and document hash),
both under the save's own guard, so a stale save records nothing. Field
values, messages, and the PDF stay out. Deleting a template records
`contract_template.deleted` with its current version and version count; these
events outlive the template until the organization is purged.

Requested forms and checks record assignment, due date and status changes
(old and new values; a status set by hand is always a manager's), deletion
(with the number of signed screening authorizations removed with it), each
document upload (revision, and whether the person or a manager uploaded it),
and background-check requests (work location, and the report a re-request
supersedes). Manager writes re-check in the transaction that the actor is
still an owner or admin. Details never hold filenames, screening results, or
consent contents. The person's signed authorizations keep their own record
(`employee_screening_consents`). Checkr's report status and result changes
are not recorded yet: they come from the provider, whose events need the
provider actor.

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
- Platform purge history: when the purge jobs delete an account or an
  organization, they record `user.purged` or `organization.purged` as activity
  with no organization, by the job, in the transaction that deletes it. It
  keeps the opaque ID, when the deletion was requested, and who asked: a root
  admin or owner by name and email, the account holder by ID only, or nobody
  for older requests that recorded no requester. It never keeps the purged
  account's name or email or the organization's name, and survives job history
  and the requester's own purge. Root admins read it under **Root Admin → Jobs
  → Purge history** (`GET /api/admin/jobs/purges`); impersonated sessions and
  everyone else cannot.
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
`organizations/membershipActivity.test.ts`,
`organizations/accessActivity.test.ts`, `issues/issues.test.ts`,
`library/libraryActivity.test.ts`, `inbox/inboxActivity.test.ts`,
`businesses/businessActivity.test.ts`, `jobs/maintenanceRequests.test.ts`,
`admin/setUserRole.test.ts`, `users/securityEvents.test.ts`,
`contracts/contractActivity.test.ts`,
`employeeForms/requirementActivity.test.ts`, and
`jobs/systemActivity.test.ts` (system actors and purges).

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
