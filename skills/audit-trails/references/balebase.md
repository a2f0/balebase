# Balebase audit map

Read `README.md`, `CONTRIBUTING.md`, `docs/product.md`, and
`docs/operations.md` in the target checkout, plus `docs/audit-activity.md` when
present. The product's checklist **Audits**
feature is one source of events; audit trails span the whole application.

## Shared activity

- `packages/api/src/activity.ts`: `findActivity`, `activityStatement`,
  `activityBatch`, and `requestActor`. API-key context must share the database
  batch with the mutation, including mutations recorded by triggers.
- `packages/api/migrations`: start with `0049_create_activity_events.sql`,
  then read later migrations that add, replace, or delete event triggers.
  Inspect the final schema in a scratch database when trigger coverage is
  uncertain; do not assume the original migration is the current model.
- `packages/validators/src/activity.ts` and
  `packages/api-client/src/activity.ts`: typed request/response contracts.
- `packages/app/src/activity/Activity.tsx`, `ActivityFeed.tsx`, and
  `activitySource.ts`: workspace and record history readers and presentation.
- `packages/api/src/organizationGroups.ts`: capability checks. Finance
  activity has stricter visibility than ordinary organization activity.

Events snapshot the actor and resource label. Roots and subjects differ:
issues may belong to an audit run, a transaction, or the workspace. Verify
both shared and record views. Global form history also has publication rules.

## Candidate slices

| Slice | Entry points and evidence |
| --- | --- |
| Access and organization lifecycle | `auth.ts`, `organizationRoleActivity.ts`, `organizationMembers.ts`, `organizationGroups.ts`, `organizationSettings.ts`, `organizationDeletion.ts`, `organizationPurge.ts`, `apiKeys.ts` |
| Audits, issues, equipment | `audits.ts`, `auditTemplates.ts`, `auditRunDiscard.ts`, `auditIssueImages.ts`, `auditIssueImageRemoval.ts`, `issues.ts`, `equipment.ts` |
| Finance and billing | `finance*.ts`, `plaid*.ts`, `billing*.ts` (checkout, subscriptions, seats, webhook, retention, deletion), scheduled jobs |
| Contracts and employee records | `contracts.ts`, `contractDraft.ts`, `contractWorkflow.ts`, `contractTemplates.ts`, `contractRecords.ts`, `employeeForms.ts`, `screening*.ts`, Checkr handlers |
| Library, inbox, business records | file/library routes, `email.ts`, `businesses.ts`, attachment handlers |
| Administrative and maintenance work | admin routes, auth role hooks, scheduled worker and maintenance jobs, `scripts/admin/purgeEmails.sh` |

Resolve actual filenames with `rg --files`; this map is a starting point,
not a coverage claim. Inspect route mounts and contract definitions to discover
new workflows. Check separate histories such as `contract_events` and provider
webhook receipts before classifying a missing shared event.

## Verification

Build local probes with the shared API test harness in
`packages/api/src/testing`: `createTestDatabase` applies every migration with
foreign keys on, and `toD1` runs each batch as one transaction, as D1 does.
A database created `before` a migration, as migration tests use, lacks the
final schema and cannot establish current trigger coverage.
Run noisy finite commands through `bun run agent:run --label <label> --
<command>` and inspect the saved evidence. Never invoke remote purge or deploy
scripts for an audit. Repository-wide `check` and `test` are required when
shipping implementation changes, not for a source-only report.

An event follows documented retention; the shared activity store is not an
immutable compliance ledger. Distinguish normal purge from loss of history
while a resource is still retained. Events must not disclose private global
drafts, cross-organization information, or restricted finance data.
