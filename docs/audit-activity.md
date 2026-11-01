# Audit activity

Activity is the shared history of consequential changes across Balebase. The
checklist Audits feature is one producer alongside equipment, projects, issues,
organization membership (roles, invitations, joining, leaving and removal),
organization creation, renames, deletion and restoration, group access,
members' two-factor requirements, API keys (including revocations that a
change to their creator's access makes), transaction annotations and categories,
bank connections (connecting, sync requests and settings, login repairs,
disconnecting, deleting imported data, and Plaid's status changes, removals,
and carry-overs), expense categories, Pro checkout starts, Billing Portal
sessions, subscription cancellations made by deleting an organization,
Stripe's subscription and seat changes, library
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
explicit actor type (migration `0086_record_system_activity.sql`):

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
of a SELECT that snapshots the affected records) from
`shared/systemActivity.ts`, in the same batch as the change and under the same
guard, with
`maintenanceActor(jobId, runId)` or a provider actor. A purge must record its
events before the guarded `DELETE` so they can snapshot what it removes, and
keep each event's subject distinct per deletion so later batches of the same
run are not taken for redeliveries.

Maintenance jobs record their changes this way: the purges of accounts and
organizations (as platform purge history, below), the Free-plan retention purge
(`organization.audit_runs_purged` on the organization, with the number of runs
removed), the discarded global form purge (`project.form_disabled` with
`reason: form_purged` on each project that had the form), and the trashed email
purge (below). Checkr report changes still stay in their current-state
columns, Checkr's own history, and job runs until their producer adopts the
provider actor.

Stripe and Plaid record their changes as providers, in the same batch as the
write and only when it changes a stored value; a write that changes nothing,
or a failed provider request, records nothing:

- `billing.subscription_changed` (root `organization_billing`, subject the
  Stripe subscription) holds the stored status, price, seats,
  cancel-at-period-end, and period end before (null for a first subscription)
  and after. Its cause is the Stripe event (`stripe_event`, also in
  `details.stripeEventId`) or, for a Checkout confirmed on the person's return
  or by the pending Checkout reconciliation, the Checkout session
  (`stripe_checkout_session`); `details.checkoutSessionId` links it to the
  `billing.checkout_started` event that names who started it. Balebase
  canceling a subscription that a new Checkout replaced records it on the old
  subscription with `reason: replaced` and `replacedBySubscriptionId`.
  A cancellation recorded as a person's `billing.subscription_canceled`
  (deleting an organization, including when the webhook records it because
  the request's own write failed) records no Stripe event as well.
  A redelivered Stripe event that now reads a newer state stores nothing,
  since its cause is already recorded; Stripe's own event for that change
  stores and records it.
- `billing.seats_changed` (same root and subject) holds the stored seat
  quantity before and after and its `source`: `membership`, caused by the
  Stripe request (`stripe_request`, its idempotency key), whose own membership
  event names the person; or `reconciliation`, caused by the hourly job run
  (a redelivered run that finds another quantity leaves it to the next run).
- `finance.connection_status_changed` (root and subject the bank connection,
  caused by the sync job run) records a status or error code change when a job
  fails for good (a login error, an error Plaid reports, or retries running
  out) or a later job finishes; Plaid's error message is left out.
- `finance.transactions_removed` (same root) counts and lists the shown
  transactions Plaid withdraws, and `finance.records_carried_over` (subject
  the disconnected connection) counts the accounts and transactions a new
  connection takes over from it. Each is caused by the attempt at the job's
  page (`plaid_sync_page`: the job run, its restarts, its page, and the
  attempt's lease); a replayed page finds its rows already moved or removed
  and records nothing.

Billing events are for owners and admins and bank connection events need
Finance capability, as for people's own events.
A Billing Portal change is Stripe's `billing.subscription_changed`; it can
only be related to the latest `billing.portal_opened` event, which names who
opened the portal, not who made the change: Stripe's portal sessions carry no
metadata, so the opener cannot ride along to the webhook. A bank login repair
(`finance.connection_repaired`) is the app's report that Plaid Link update
mode succeeded, since Plaid tells only the browser; it must consume a
single-use update session the reporter opened for that connection
(`finance_login_repair_sessions`).

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
sees people joining, leaving, being removed or changing role, API keys being
created and revoked, and the organization's creation and renames. Root admins
read the organization's own history (creation, renames, deletion and
restoration, and the subscription cancellations a deletion made) on its admin
detail page, including while it is deleted. The
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
members. Root admins read a discarded global form's history and versions
through `/api/admin/audit-templates/:id/activity` and `/versions` until the
purge deletes them. Form events name the version they saved: creation (with
the global form a copy came from and the published version it started from),
saved versions, publication, unpublication, discards, and restores.
Organizations therefore see a global form's publications but never its
unpublications, discards, or restores.
Adding a producer with restricted details also requires reviewing the shared
feed's reader permissions, labels, and navigation.

History follows the resource's documented retention. It is not an immutable
compliance ledger. Purging an organization removes its activity; purging an
audit run or form removes that root's history, though the Free-plan retention
purge leaves its count on the organization and the form purge leaves each
affected project's removal. Deleting a disconnected bank
connection's imported data removes that connection's and its transactions'
history, but keeps one `finance.connection_data_deleted` event naming who
deleted it and how many accounts, transactions, annotations, transaction issues
(and open ones), and email links went; the issues, with their history, and the
links are deleted with their transactions. Historical
imports must be marked as such and contain only facts actually retained. Do not
reconstruct unknown editors, previous values, or timestamps from current state.

## Organization membership

Better Auth's organization endpoints carry the request's actor into the write
they make (`auth/organizationActivity.ts`), so the triggers of migrations 0057,
0083 and 0085 record each change atomically with it: creating an organization
(`organization.created`, at sign-up or from `/organization/create`, naming the
creator as founding owner and `details.via`), role changes, invitations sent,
canceled (including the cancel a re-invite makes) or declined, a person
joining by invitation (actor: the person; details: the role and the inviter),
and organization renames, URL name and logo changes. Removing a member and
leaving run as one batch (`organizations/memberRemoval.ts`) that records the
membership's end with its role and the API keys it revokes
(`revokedApiKeys`), each group the person loses as a group update, and each
equipment item returned to unassigned, all attributed to the remover (or to
the person leaving), then revokes the person's unexpired keys and deletes the
membership. That batch re-checks that the remover still owns or administers
the organization and never removes the last owner. Deleting an
organization (by an owner or a root admin, `details.via`) and restoring it
record events in the same batch as the change; the restoration keeps who had
deleted it, which the organization row then clears. Deleting a Pro
organization first cancels its subscriptions in Stripe, and each cancellation
Stripe confirms records `billing.subscription_canceled` (the subscription, its
previous status and seats, `details.via`) with the persisted billing state,
attributed to the deleting owner or root admin. It stays when the deletion
then fails or changes nothing, since the paid plan has ended either way, and
is recorded once per subscription; a Stripe refusal records nothing. Who is
canceling is stored before Stripe is asked (`billing_cancellation_intents`,
migration `0087_record_cancellations_and_repairs.sql`), with a marker the
request sends as the cancellation's comment (`cancellation_details[comment]`).
Only a cancellation Stripe reports with that marker is credited, so one made
elsewhere, such as in the Billing Portal, never is. When the request cannot
persist the cancellation, the webhook that reports it records the event
instead, and a retry asks Stripe before replacing an unresolved intent: a
subscription already canceled is credited to the earlier request.
The deletion event lists the canceled subscription IDs. Root admins see these
cancellations on the organization's admin page with its lifecycle events.
Rejected requests and saves that change nothing record nothing. A membership
deleted with no request behind it, as when an account is purged, is not
recorded on the organization yet; equipment is still unassigned then.

An API key acts as its creator, so a change that leaves the creator neither
owner nor admin ends the key for good: a role change revokes the creator's
unexpired keys in the same statement (listed in the role event's
`revokedApiKeys`), as removal and leaving do in their batch. Each revocation
records `api_key.revoked` with the person who made the change and
`details.reason` (`role_changed`, `member_removed`, `member_left`); the key's
`revoked_reason` keeps it for the API keys page. Regaining the role or
rejoining never restores a key; the person makes a new one. Removals recorded
before migration 0085 list the keys they stopped as `apiKeys`; those keys,
and any other key whose creator had already lost access, were revoked by that
migration with `revoked_reason = 'creator_access_ended'` and no revoker or
event, because no person made that change.

## Library, inbox, and businesses

Uploading, moving, and permanently deleting a library file records an event on
the file (`library_file`) naming its filename, content type, size, and folder,
never its contents or storage key. Creating, renaming, and deleting a folder
records one on the folder (`library_folder`); a deletion counts the files it
returns to the library root and the email links it removes, and records each
of them on its own record in the same batch: a `library.file_moved` per file
(`details.via = 'folder_deleted'`) and an `inbox.email_unlinked` per link.
Moving a file to the folder it is in, or renaming a folder to its current
name, records nothing.
A file's deletion commits with its event and queues its bytes for the
deleted-object cleanup, which retries if removing them fails.

Moving an email to Archive or Trash, and restoring it, records an event on the
email (`inbound_email`), labelled with its subject and naming only its sender
and the folder it left, never its body or attachments; restoring no longer
erases who trashed it. Linking an email to a folder, equipment, or a
transaction, and unlinking it, records an event on that record with the email as
the subject, so a transaction's links need Finance access wherever they are
read. Deleting a folder or equipment records an `inbox.email_unlinked` for
each link it removes (`details.via = 'target_deleted'`), attributed to the
person deleting it, so the email's history shows when and by whom the link
ended. `equipment.deleted` also keeps who held the item (`assignedTo`,
`assigneeName`, `assigneeEmail`) and its `emailLinkCount`. The **Purge trashed
email** job (`purgeTrashedEmails`, run on request from **Root Admin → Jobs**;
it replaced the `emails:purge` operator script) permanently deletes email that
has been in Trash for 30 days. In the same transaction it records
`inbox.email_purged` on the email, by the job, counting its attachments and
folder and equipment links but naming no transaction, and
`inbox.email_unlinked` (`details.via = 'email_purged'`) on each record a legacy
trashed email was still linked to. Its raw message and attachments are removed
by the deleted-file cleanup after that commits. When Plaid removes a
transaction, its links are hidden with it, and kept, without an event. Inbound
mail is a provider action with no user actor: the stored message and its raw
`.eml` are its record.

Creating, editing, and deleting a business records an event on the business
(`business`). Edits list each changed field with its old and new value; a save
that changes nothing, a duplicate EIN or DUNS number, and a save racing another
change record nothing. Every member can read the feed, so events show only the
last four digits of an EIN or DUNS number.

Folders, files, emails, and businesses show their own history. A folder's
history also lists the file events that name it: uploads into it, moves into
or out of it, and deletions of files in it. A file's history
(`GET /api/objects/:id/activity`, MCP `list_library_file_activity`) stays
readable after the file is deleted, as its events are in the shared feed. An
email's history also lists its links, recorded on the linked records.

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
  ran the script (`actor_kind = 'operator'`, no user ID).
- `user_deletion_events` records account deletion requests and cancellations.
  Root admins read both, merged and newest first with each actor's snapshot and
  kind, from **View history** on the Users page
  (`GET /api/admin/users/:userId/history`).
- `maintenance_requests` records every manual maintenance request, including
  one that joins an active run, with the requester's snapshot. It outlives the
  30-day job history and the requester's account. Each request also logs a line
  on its run, and the run keeps the first requester's name and email. Root
  admins read it under **Manual requests** on the Jobs page
  (`GET /api/admin/jobs/requests`).
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
- `user_security_events` records a person's own sign-in security and profile
  changes by trigger: two-factor on and off, replacing the authenticator app
  (enrolling again while two-factor is on), regenerating backup codes (the
  write for `/two-factor/generate-backup-codes` carries a mark, so using a
  backup code records nothing), password changes and resets, and name (old and
  new value) and picture changes (the picture's address is not kept). The
  person reads it under Account settings → Security; root admins read it in
  D1.

The role, deletion, and maintenance request readers are for root admins only,
never organization feeds; impersonated sessions are refused.

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
`organizations/accessLifecycle.test.ts`,
`organizations/accessActivity.test.ts`, `issues/issues.test.ts`,
`finance/financeActivity.test.ts`, `billing/billingActivity.test.ts`,
`library/libraryActivity.test.ts`, `library/recordHistory.test.ts`,
`inbox/inboxActivity.test.ts`,
`businesses/businessActivity.test.ts`, `jobs/maintenanceRequests.test.ts`,
`admin/setUserRole.test.ts`, `admin/platformHistory.test.ts`,
`admin/discardedAuditForms.test.ts`, `users/securityEvents.test.ts`,
`contracts/contractActivity.test.ts`,
`employeeForms/requirementActivity.test.ts`, and
`jobs/systemActivity.test.ts` (system actors and purges),
`billing/billingProviderActivity.test.ts` (Stripe), and
`finance/financeProviderActivity.test.ts` (Plaid).

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
