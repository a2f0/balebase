# Product reference

[Local setup](../README.md) · [Deployment and maintenance](operations.md)

## Authentication

The API uses Better Auth with D1-backed email/password accounts and cookie
sessions. New accounts receive the `user` role. The `admin` role can access
admin-plugin operations and the example `GET /api/admin` route. Passwords must
be 12–128 characters, reset links expire after one hour, and a successful reset
revokes the user's existing sessions.

The main endpoints under `https://api.tearleads.de/api/auth` are:

- `POST /sign-up/email`
- `POST /sign-in/email`
- `POST /sign-out`
- `GET /get-session`
- `POST /request-password-reset`
- `POST /reset-password`
- `GET /admin/list-users` (admin only)
- `GET /organization/list`
- `POST /organization/update`

After creating the first account, bootstrap its admin role with:

```sh
bun run auth:set-role person@example.com admin
```

Pass `--local` as the third argument to update the local D1 database instead.
Later role changes can use Better Auth's admin API. Public account registration
is enabled for now. The client includes sign-up, sign-in, sign-out, reset
request, and new-password screens. Object-storage endpoints require an
authenticated session, and each organization's upload library is isolated in
D1 with new R2 objects stored below an organization-specific prefix.
Registration sends a
one-hour verification link, but unverified users can sign in immediately. The
library displays a reminder with a resend action until the address is verified.
Root admins can list registered accounts at `/root/users` and inspect all
organizations at `/root/organizations`. Clicking an organization name opens
its admin detail page with the organization's people, employee requirements,
Checkr results, and links to
available Checkr reports, without changing the admin's active workspace.
Authenticated API requests record each account's last active date; an admin
impersonating someone does not. Root admins see it on both pages, and
organization owners and administrators see it for members under
Organization → People. Other members do not receive it.
The shared inbound mailbox is at `/inbox`. Each account receives a default
organization at signup; existing accounts are backfilled by the organization
migration. Organization owners and
administrators can rename their organization at `/organization`. The API
independently enforces the platform `admin` role for administrative data.

Root admins can run maintenance from `/root/jobs`. Each **Run now** action
requires confirmation and uses the same retention rules and batch sizes as the
hourly production job (`17 * * * *`, UTC). The API lists jobs at
`GET /api/admin/jobs` and accepts `POST /api/admin/jobs/:jobId/run` with JSON
`{"confirm":"<jobId>"}`, an authenticated admin session, and the configured
client `Origin` header. The response contains the run ID, outcome, timing, and
result. Keep the page open while a manual run executes; if the connection drops,
check logs before retrying. This is a synchronous Worker invocation, not a durable
queue. Staging supports manual runs but has no cron schedule.

Users can request or cancel account deletion under **Account settings → General**.
Apply migration `0048_create_user_deletion_requests.sql` before deploying this
feature. The `purgeRequestedUsers` job processes up to 25 requests per run after
30 days, both hourly and on demand. Accounts remain active during the waiting
period. Admin and system accounts, members of active organizations, and users
referenced by retained audit, financial, or contract records are skipped. Contract
creators, senders, and event actors remain linked to their history. Blocked requests
rotate through the batch so they do not starve later requests. Organizations and
their retained records must be managed separately; this does not erase all data
an organization holds about a person. Users can cancel until their account is
actually purged. Cancellation and eligibility are rechecked at deletion time.

Both scheduled and manual jobs emit structured `maintenance_job` logs with a
`runId`, `jobId`, trigger, initiating user ID (manual runs), timestamps, duration,
and result or failure. User deletion requests, cancellations, and individual
purge outcomes emit separate events. Failed jobs can have partial effects;
inspect their logs before retrying. A completed user-purge run reports both
`purged` and `blocked` counts. Other jobs report their existing result: deletion
counts, reminder count for contract maintenance, or null for seat reconciliation.

To inspect executions, select the API Worker in Cloudflare **Workers & Pages →
Observability** and filter on `event = maintenance_job`, `jobId`, or `runId`.
Both API configurations enable Workers Logs with full head sampling. Cloudflare
captures invocation metadata, console output, and errors; it does not infer
application deletion counts. [Workers Logs][workers-logs] retains logs for three
days on Free and seven days on Paid, subject to service limits. Export logs for
longer retention; these are operational logs, not an immutable application audit
ledger. [Cloudflare Audit Logs][cloudflare-audit-logs] records Cloudflare account
and configuration actions and is separate from this application's user actions.

[workers-logs]: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
[cloudflare-audit-logs]: https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/

Organization owners and organization admins can manage groups and group
members at `/organization`. Groups use Better Auth teams underneath and can
grant application capabilities. Every organization starts with a Finance group
containing its initial owner; Finance navigation and every `/api/finance`
request require membership in a group with the Finance capability.

Authentication needs a strong `BETTER_AUTH_SECRET` in the ignored
`.secrets/root.env`. Production password reset additionally requires Cloudflare
Email Sending to be enabled for `auth.tearleads.de`, with
`security@auth.tearleads.de` permitted as a sender. Sending DNS records and
DMARC policy are isolated under `auth.tearleads.de`; Google Workspace remains
responsible for mail at the apex. The deployment script uploads the auth secret
to the Worker but never places it in Wrangler configuration or Terraform state.

## API keys and MCP

Organization owners and admins create API keys under **Organization → API
keys** (`/organization/api-keys`). Each key has a name, an access level (read
everything, or read and write everything), and an expiration of 30 days, 90
days, one year, or never. The `tlk_` token is shown once at creation; D1 keeps
only its SHA-256 hash and an identifying prefix. An organization can have 50
active keys. Creating and revoking keys appear in the Activity feed, and each
key records when it was last used, to the minute.

A key acts as the person who created it, inside its own organization only. It
never carries the platform `admin` role, cannot be created while impersonating,
and follows the same seat, Finance group, and two-factor rules as its creator's
session. A key counts as two-factor verified only when the session that created
it was; if the organization later requires two-factor authentication, create a
new key after signing in with it. A key stops working when it is revoked or
expires, when its creator is no longer an owner or admin there, or when the
organization is deleted. Send it as `Authorization: Bearer <key>`. Keys reach
the workspace routes: activity, audits, businesses, contracts, employee forms,
equipment, finance, inbox, library folders and files, groups, `/api/me`, and the
people list. Read keys may only use `GET`. Account settings, billing,
organization settings, API key management, root administration, and Better Auth
endpoints stay session-only, so a leaked key cannot create more keys or change
sign-in security.

The MCP server is at `https://api.tearleads.de/mcp` and uses Streamable HTTP
with the official TypeScript SDK. It serves the stateless `2026-07-28`
revision and, through the SDK's stateless fallback, clients that still open
with `initialize`. It keeps no sessions and has no standalone event stream.
It accepts only API keys and rejects browser origins other than the client.
Each tool calls one REST route with the caller's key, so the route's own
validation and permissions apply; read keys are offered only the read tools.
Tools do not upload or download files, connect or remove Plaid institutions,
or reconcile Checkr invitations; use the app for those. Connect Claude Code
with:

```sh
claude mcp add --transport http tearleads https://api.tearleads.de/mcp \
  --header "Authorization: Bearer <key>"
```

Other clients need Streamable HTTP and a custom header. There is no OAuth
authorization server yet, so clients that only support OAuth cannot connect.
Apply migration `0060_create_organization_api_keys.sql` before deploying.

## Library folders and inbox links

Library documents can be organized into flat, organization-scoped folders,
each opened at `/library/<folder-id>`. A document lives in at most one folder;
deleting a folder returns its documents to the library root.

Inbox messages can be linked to library folders, equipment, and imported
finance transactions. Links live in one polymorphic table,
`inbound_email_links`, whose `target_type` is `library_folder`, `equipment`,
or `finance_transaction`. A polymorphic reference cannot carry a foreign key,
so database triggers remove links when their target is deleted, and purging
an email cascades to its links. Email has three statuses: Inbox, Trash, and
Archived. The message toolbar archives email or moves it to Trash; archived
email leaves the Inbox but keeps its attachments and links, remains available
from linked records, and can be moved back to Inbox. Linked email cannot be
moved to Trash, including email with Finance links hidden from the current
user. Email in Trash is eligible for removal by the manual `emails:purge`
command after 30 days and can be restored until it is purged. Legacy email
already in Trash keeps its links but is hidden from
linked records until restored. Links to
transactions that Plaid has since removed are hidden. Creating, removing, or
seeing transaction links requires the Finance capability. A folder lists its
linked emails, and a transaction shows its linked emails in the Finance
transaction list.

PDF and image attachments preview in the inbox. PDFs are rendered in the
browser with [PDF.js](https://mozilla.github.io/pdf.js/), which loads on the
first preview; the client build copies its image decoders, colour profiles,
character maps, and standard fonts to `/pdfjs/`. Only raster image formats are
previewed, so SVG attachments download instead.

## Equipment

The organization-scoped Equipment page at `/equipment` tracks computers, cell
phones, and monitors with their make, model, serial number, and purchase date.
Each item can be assigned to one organization member at a time, and removing a
member from the organization returns their equipment to unassigned. Every
member can view equipment; organization owners and admins add, edit, assign,
and delete it. Receipts and other inbox emails link to equipment the same way
they link to folders, and any member can link or unlink them. The API owns the
list of equipment types, so adding one needs no migration; an item keeps its
type if that type is later retired.

## Contracts and e-signature

The organization-scoped Contracts page at `/contracts` sends PDFs for
signature. Any member uploads a PDF (up to 10 MB), adds signers, and places
signature, initials, date signed, full name, and text fields on its pages.
Drafts save automatically as they are edited, and sending checks that every
signer has a name, a valid email, and a signature field. Signers sign in any
order or one after another; a sequential signer is emailed only once everyone
before them has signed. A contract can carry a due date, after which it is
flagged overdue but stays signable, and a reminder interval. The hourly cron
re-emails signers who have not signed once the interval has passed since their
last email, and **Send reminder** emails them immediately, at most once an
hour. A sent contract can be voided, which invalidates its signing links;
drafts, completed, declined, and voided contracts can be deleted.

Contract templates at `/contracts/templates` keep a PDF and placed fields
without assigning actual people. Fields belong to named signer roles such as
Employee or Company. **Save version** appends an immutable version; you can
select and use older versions, or edit one to create the next version. **Use
this version** maps each role to a person's name and email, creates a draft
with all fields already assigned, and lets you review it before sending.
The draft owns its own PDF, recipients, and fields and records the source
version, so changing or deleting the template does not change existing
contracts. Deleting a template or purging its organization queues its shared
PDF for cleanup. Migration `0050_create_contract_templates.sql` adds the
versioned template records and contract provenance.

Signers need no account. Each receives a link to `/sign/<token>` from
`security@auth.tearleads.de`, with the sender's address as reply-to. The token
is an HMAC-SHA256, keyed by `BETTER_AUTH_SECRET`, of the recipient ID and a
random nonce; only the nonce and a hash of the token are stored, so reminders
can resend the same link. A link must still derive from the current secret, so
rotating `BETTER_AUTH_SECRET` invalidates every outstanding signing link; the
next reminder carries a fresh one. A signer adopts a typed or drawn signature,
agrees to use electronic records, and finishes, or declines with a reason,
which ends the contract for everyone.

When the last signer finishes, the API stamps each signature and value into
the PDF with [pdf-lib](https://pdf-lib.js.org/), honouring page rotation, and
appends a certificate of completion listing the original document's SHA-256,
each signer's time, IP address, and browser, and the audit trail. If stamping
or routing fails after a signature is recorded, the hourly cron finishes the
contract. The signed copy is emailed to every signer and the sender (attached
when it is 8 MB or smaller) and can be downloaded from the contract or the
signing link. Original and signed PDFs live in R2; deleting a contract or
organization queues them in `deleted_object_cleanup` for the scheduled purge.

## Audits and checklists

Authenticated users can build organization-scoped checklist templates at
`/audits`, start audits from them, record pass/fail/N/A or text responses, and
raise issues with priorities and optional organization-member assignees. Audit
issues can include a description, be reassigned, and have up to ten JPEG, PNG,
GIF, or WebP images attached. Image metadata is organization-scoped in D1 and
the private image bytes are stored under organization and issue prefixes in R2.
The Cloudflare Images binding validates image structure, type, and dimensions
and normalizes uploads to a single non-animated frame before anything is written
to storage.
Audit runs snapshot their template so later template edits do not rewrite
history.
Root admins manage global forms in **Global Audits**. New forms are private
drafts until published. Published forms can be unpublished and published again;
unpublishing hides them from organizations and prevents new runs and copies,
while preserving versions and existing audit runs. Only drafts can be discarded.
Discarded drafts leave the admin list but remain stored with their history.
Publication changes save a new version, including the editor's current changes,
and reject stale versions just like other template saves. Organizations can only
read published versions and their activity; draft and unpublished history stays
private to root admins.
Apply migration `0058_publish_legacy_global_audits.sql` before deploying these
controls. Earlier global versions were shared regardless of their stored draft
status; the migration marks them published to preserve their existing availability.
The workspace **Activity** page and each form and audit's Activity section show
who created forms, started audits, changed answers, completed or reopened audits,
raised or reassigned issues, resolved or reopened issues, and attached or removed
images. Answer history includes the previous and new values; each question also
shows its last saved editor. Unsaved answers are labeled, and concurrent edits
require reloading before overwriting another person's saved work.

Apply migration `0049_create_activity_events.sql` before deploying. The reusable
`activity_events` model records an organization, root resource, subject, action,
actor identity snapshot, timestamp, and action details. Audit database triggers
write activity atomically with successful changes; explicit image removals use
the same transactional batch. `GET /api/activity` lists the active organization's
activity; `/api/audits/templates/:id/activity` and
`/api/audits/runs/:id/activity` provide resource histories. All use cursor
pagination. Shared global form activity is visible through its form history.
Saving a run requires `expectedRevision` from its latest detail response; stale
revisions return 409, and missing or invalid revisions return 400.
The migration imports known creators and template versions as historical
records. Earlier answer edits and completion actors were not stored and cannot
be reconstructed. Activity follows its root resource's retention and is removed
when a run, form, or organization is purged.

Customizing a global template creates a new organization-scoped form instead
of changing the shared template or its version history. Platform administrators
use a separate management action when they intentionally publish a new global
version.

The global NFPA 70E readiness checklist is a shared starting point based on
broad electrical-safety themes. It is not an official checklist,
certification, or substitute for the current standard, an employer's required
risk assessment, or qualified professional judgment. Consult the
[NFPA 70E publication](https://link.nfpa.org/all-publications/70E/2024) and
[OSHA electrical safety requirements](https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.333)
when adapting it to a workplace.

The global U.S. residential construction baseline adds a jurisdiction-portable
starting point for detached one- and two-family dwellings and townhouses. Its
253 controls retain source, applicability, trade, phase, hazard, evidence, and
risk metadata before being compiled into the current checklist format. It is a
baseline rather than a code-compliance certification; see the
[residential audit library](residential-audit-library.md) for its source,
licensing, validation, and jurisdiction-overlay rules.

## Finance and Plaid

The organization-scoped Finance page at `/finance` uses
[Plaid Link](https://plaid.com/docs/link/) to connect financial institutions
and [Transactions Sync](https://plaid.com/docs/api/products/transactions/) to
import up to 24 months of account and transaction history. Syncing is manual in
this first release; Plaid webhooks can be added later for automatic updates.
Users can add organization-scoped notes, labels, and a reviewed flag to
imported transactions.

Each organization keeps its own list of expense categories at
`/finance/categories` (with a one-click common set), and each transaction can
have at most one category, chosen inline in the transaction list. Deleting a
category leaves its transactions uncategorized. `/finance/reports` totals
expenses by category over a period: posted outflows count as spending, refunds
assigned to a category reduce it, and unassigned transfers and loan or card
payments are reported separately so money moved between the organization's own
accounts is not double-counted. Totals are grouped by currency. Earlier
free-text category overrides were converted into categories by migration
`0034`.

Disconnecting an institution calls Plaid's `/item/remove`, erases the stored
access token, and retains the imported history and annotations. A later Link
connection reconciles unambiguous matching accounts and transactions onto the
same internal records so annotations survive changed Plaid IDs. Deleting the
local history is a separate, permanent action that is only available after the
institution has been disconnected.

Plaid access tokens are encrypted with AES-GCM before being stored in D1. Add
these values to the ignored `.secrets/root.env` before local Plaid testing or a
production deployment:

```sh
export PLAID_CLIENT_ID=your-client-id
export PLAID_SECRET=your-sandbox-secret
export PLAID_TOKEN_ENCRYPTION_KEY=your-base64-32-byte-key
```

Generate the encryption key once with `openssl rand -base64 32`, store the
result, and do not replace it casually: existing connections require the same
key to decrypt their Plaid access tokens. The deployment script uploads all
three values as encrypted Worker secrets.

The Worker currently uses Plaid Sandbox. Add
`https://app.tearleads.de/finance` to the Plaid Dashboard's allowed redirect
URIs for OAuth institutions. Before switching `PLAID_ENV` to `production` in
the API Wrangler configuration, replace the Sandbox secret with the Production
secret and complete Plaid's application and company profile requirements.

## Employee forms and screening

Organization managers assign forms, background checks, and credit checks while
inviting a member or later from Organization → People. Each requirement has a
due date. Members upload PDF, JPEG, or PNG forms (up to 10 MB) to private R2
storage; managers review and complete them. Only the member and organization
managers can download a submitted form. Checkr results are visible only to
managers. Deleted or replaced form files are queued for R2 cleanup.

Background and credit screening use Checkr's hosted invitation flow. A manager
starts a screening with the person's US work state and optional city. Checkr
emails the person to collect the information and authorization it requires.
Checkr webhooks update a screening when its invitation or report changes. An
hourly Worker task refreshes up to 24 screenings that are unfinished or whose
webhook refresh failed, least recently checked first, in case a webhook was
missed. Managers can also use **Refresh check** to retrieve the current
invitation and report status at any time. A completed report is marked complete
in the app; a `consider` result still needs the manager's review in Checkr.
If a start request loses its response, retry it while Checkr's idempotency key
is valid. For an older unresolved request, look up the invitation in Checkr and
enter its ID in **Link invitation**. The app verifies the candidate, package,
and creation time before linking it. Do not start a new check until the old
request is reconciled.

Set these optional values in `.secrets/root.env` for production deployment or
`.secrets/staging.env` for staging and local development:

```sh
CHECKR_API_KEY=your-checkr-secret-key
CHECKR_BACKGROUND_PACKAGE=your-background-package-slug
CHECKR_CREDIT_PACKAGE=your-employment-credit-package-slug
```

The local and staging Workers use Checkr staging; the production Worker uses
Checkr production. Checkr must credential the account and provision a staging
account. Obtain the package slugs from the matching Checkr account, and ask
Checkr to enable an employment credit screening package if needed. The
deployment scripts upload the three values as Worker secrets when present.
Without a configured package and key, managers can still track a check
manually.

Register the API's webhook URL with each Checkr account, either under
**Developer Settings** in the Checkr Dashboard or with `POST /v1/webhooks`:

| Checkr account | Webhook URL |
| --- | --- |
| Staging | `https://api-staging.tearleads.de/api/checkr/webhook` |
| Production | `https://api.tearleads.de/api/checkr/webhook` |

Checkr signs each delivery with the account's API key, so the Worker's
`CHECKR_API_KEY` must belong to the account that sends the webhook. The endpoint
rejects unsigned or mis-signed requests and acknowledges valid ones before
refreshing the matching screening. Checkr staging completes reports only for
the mocked candidates in the data document Checkr provides with the staging
account; any other candidate's report stays `pending` indefinitely.

## Billing and plans

Every organization starts on the cardless Free plan with one usable member
seat, up to five organization form templates, and 30 days of audit-run history.
An hourly Worker task removes older Free-plan audit runs and their associated
issue images. Tearleads Pro costs $10 per active organization member each month
and includes unlimited form templates and audit history. Membership hooks update
the licensed Stripe subscription quantity, and an hourly reconciliation repairs
any quantity drift.

Owners and organization admins can upgrade or manage billing at
`/organization/billing`. Subscription management uses Stripe's hosted Billing
Portal. Checkout uses Stripe's hosted page unless `STRIPE_PUBLISHABLE_KEY` holds
a publishable key from the same Stripe account and mode as the secret key; then
the billing page embeds Stripe's Payment Element, styled with the app's theme
tokens. Add the following values to the ignored `.secrets/root.env` before local
billing work or a production API deployment:

```sh
export STRIPE_SECRET_KEY=your-live-or-test-secret-key
export STRIPE_WEBHOOK_SECRET=your-endpoint-signing-secret
export STRIPE_PRO_LEGACY_PRICE_IDS=comma-separated-previous-pro-price-ids
export STRIPE_PRO_PRICE_ID=your-matching-live-or-test-price-id
export STRIPE_PORTAL_CONFIGURATION_ID=your-matching-portal-configuration-id
export STRIPE_PUBLISHABLE_KEY=your-matching-publishable-key
```

The current price ID is required for local billing; legacy price IDs, the
Portal configuration, and the publishable key are optional. Add a previous Pro
price ID to the legacy list before rotating the current price so existing
subscriptions keep their entitlements. Local development overrides the
production IDs in Wrangler with these values, so test-mode keys must be paired
with test-mode IDs. The public Stripe webhook URL is
`https://api.tearleads.de/api/billing/webhook`. The non-secret Pro price,
optional Billing Portal configuration ID, and optional publishable key belong in
`packages/api/wrangler.jsonc`; the API deployment script uploads the two secret
values as encrypted Worker secrets and requires a live-mode API key for
production.
