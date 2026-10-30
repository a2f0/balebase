# Troubleshoot bank connections

Use this runbook for any Plaid institution when finance syncing stops or
**Update login** cannot finish. Start read-only: separate the saved Item's
state, institution-wide health, and the browser's Link session before changing
code or asking the user to repeat a bank login.

## Preserve the connection and establish scope

Confirm the environment, user, organization, and connection first. Bank names
are not unique: use the exact `institution_id` stored on that organization's
`plaid_items` row, not a similarly named bank from search. Keep customer emails,
Item IDs, account details, and diagnostic traces out of commits and public PRs.

Do not disconnect/reconnect, revoke bank consent, replace tokens, delete jobs,
or advance cursors as a diagnostic step. Update mode repairs the existing Item
without replacing its accounts or transaction identifiers. Disconnect/reconnect
creates a new Item and relies on matching old records; it can duplicate history
or leave annotations on old copies.

For production, run this from the repository root in Bash, replacing both
placeholders with the confirmed IDs. It selects no credentials, cursors,
transaction details, or job checkpoint payloads. If you do not have authorized
production access, stop and request it rather than using another environment.

```bash
(
  set +x
  set -eu
  source scripts/lib/cloudflareEnv.sh
  load_cloudflare_env
  cd packages/api
  bunx --bun wrangler d1 execute DB --remote --json --command "
    SELECT id, organization_id, institution_id, institution_name, status,
           error_code, error_message, last_synced_at, updated_at, disconnected_at
    FROM plaid_items
    WHERE id = 'REPLACE_CONNECTION_ID'
      AND organization_id = 'REPLACE_ORGANIZATION_ID';
    SELECT id, source, status, error_code, created_at, started_at, finished_at,
           pages, added, modified, removed
    FROM job_runs
    WHERE connection_id = 'REPLACE_CONNECTION_ID'
      AND organization_id = 'REPLACE_ORGANIZATION_ID'
    ORDER BY created_at DESC LIMIT 10;
  "
)
```

Record the last successful sync and first observed failed job with explicit
UTC timestamps. `ITEM_LOGIN_REQUIRED` means the existing Item needs user
reauthorization; it does not establish why reauthorization fails. A failed job
with zero pages is different from a stuck queue or an import that partially ran.
Check job logs when needed, keeping the same connection and organization scope.

## Probe the institution, not the customer's credentials

The decisive health check is Plaid's **read-only**
`POST /institutions/get_by_id` with `options.include_status: true`. Although
it uses POST, it only retrieves institution metadata. It uses the application's
Plaid client ID and secret, **not** an Item access token, bank password, or MFA
code. Do not decrypt a customer's token for this check.

Run this production probe from the repository root in Bash. Replace the
institution placeholder with the exact stored ID. The explicit production URL
and production environment loader must stay paired. Do not point production
credentials at Sandbox or at an arbitrary host. The US country code matches
Balebase's Link configuration.

```bash
(
  set +x
  set -eu
  source scripts/lib/cloudflareEnv.sh
  unset PLAID_CLIENT_ID PLAID_SECRET
  load_tier_env prod
  export PLAID_INSTITUTION_ID='REPLACE_INSTITUTION_ID'
  bun --no-env-file -e '
const institutionId = process.env.PLAID_INSTITUTION_ID;
const clientId = process.env.PLAID_CLIENT_ID;
const secret = process.env.PLAID_SECRET;
if (!institutionId || institutionId === "REPLACE_INSTITUTION_ID" ||
    institutionId !== institutionId.trim() || !clientId || !secret) {
  console.error("Set the exact institution ID and load production Plaid credentials.");
  process.exit(1);
}
try {
  const response = await fetch("https://production.plaid.com/institutions/get_by_id", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": clientId,
      "PLAID-SECRET": secret,
      "Plaid-Version": "2020-09-14",
    },
    body: JSON.stringify({
      institution_id: institutionId,
      country_codes: ["US"],
      options: { include_status: true },
    }),
  });
  const data = await response.json();
  const institution = data?.institution;
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    environment: "production",
    httpStatus: response.status,
    requestId: data?.request_id ?? null,
    errorCode: data?.error_code ?? null,
    institutionId: institution?.institution_id ?? institutionId,
    name: institution?.name ?? null,
    oauth: institution?.oauth ?? null,
    connectionAvailability: institution?.connection_availability ?? null,
    status: institution?.status ?? null,
  }, null, 2));
  if (!response.ok || institution?.institution_id !== institutionId)
    process.exitCode = 1;
} catch {
  console.error("Plaid health probe failed (network, timeout, redirect, or invalid JSON). No health conclusion is available.");
  process.exitCode = 1;
}
'
)
```

The probe has a bounded timeout, refuses redirects, disables automatic `.env`
loading, and prints only selected response fields. Credentials stay in the
process environment and request headers, not command arguments or output.
Never use shell tracing, `curl -v`, raw request dumps, or environment dumps
around credentials. If saving output, use an approved private incident folder,
not the repository; preserve the observation timestamp and Plaid request ID.

A nonzero exit means the lookup failed, not that the bank is down. A zero exit
means the lookup succeeded, not that the bank is healthy. Missing/null health
fields mean **unknown**, not healthy. Staging uses its own Sandbox credentials
and endpoint; Sandbox health is available only for selected test institutions
and says nothing about production banks.

## Interpret the response

Inspect `status.item_logins` for connection and reauthorization problems, and
`status.transactions_updates` for transaction-refresh problems. They are
separate: existing Items may refresh successfully while new logins and repairs
are failing. Inspect other product-specific sections only when relevant.

- `breakdown.success`, `error_institution`, and `error_plaid` are fractions;
  multiply by 100 to report percentages. Attribute errors as **Plaid reports**
  them rather than claiming independent knowledge of the bank's root cause.
- The coarse `status` (`HEALTHY`, `DEGRADED`, `DOWN`) is deprecated in favor of
  the breakdown; report both when available. `DOWN` means nearly all requests
  fail, not that Balebase's application server is down.
- Record `last_status_change` separately from your `observedAt`. Neither proves
  when this user's problem began. The breakdown window varies from recent
  minutes to six hours; investment-update windows can be 24 hours or longer.
- `connection_availability: SUPPORTED` and a supported Transactions product do
  not guarantee current login health. A healthy aggregate also does not rule
  out an Item-specific consent problem or a browser defect.

During a login outage, preserve the Item and avoid repeated repair attempts.
After health recovers, retry **Update login** on the existing connection, then
verify the queued sync succeeds and `last_synced_at` advances. **Sync now** can
check whether an Item already healed, but cannot repair one that continues to
return `ITEM_LOGIN_REQUIRED`. Do not declare recovery from a bank's success
page or from institution health alone.

## If health does not explain the failure

Capture a fresh attempt with the user's participation, preferably one Link
session in one tab. Start a live tail before the attempt, from `packages/api`
after loading the production Cloudflare environment:

```sh
bunx --bun wrangler tail balebase-api --format json
```

Stop the tail afterward; restart it after a Worker deploy. Treat raw tail
output as sensitive because it can contain unrelated requests and headers.
Keep it private and extract only the relevant diagnostic events; never attach
an unfiltered tail or browser HAR to a PR or support ticket. Wrangler's JSON
stream may contain concatenated pretty-printed objects, not one JSON object per
line, so decode complete objects rather than splitting on newlines.

Correlate these events by connection, session, request ID, and timestamp:

- `plaid_link_token_created`: confirm `mode: update` and the intended connection.
- `plaid_link_diagnostics`: Link session ID, error, `oauthResume`, and event trail.
- `plaid_request_failed`: provider path, error code, and request ID.
- `finance_sync_attempt_failed` and the saved job: whether the app reached sync.

`OPEN_OAUTH` followed by `FAIL_OAUTH` is a popup timeout, not proof of which
component failed. `INSUFFICIENT_CREDENTIALS` describes insufficient OAuth
authorization, not necessarily a wrong bank password. The diagnostics reporter
sends a best-effort snapshot on success/exit: late events, submission failures,
or page closure can leave gaps. No saved sync job alone does not prove that
Link never called `onSuccess`; the subsequent app request could have failed.

If needed, inspect both the original tab and bank popup for blocked requests,
CSP/COOP errors, page reloads, and the final destination's **origin/path only**.
Do not collect OAuth query strings, cookies, tokens, passwords, or MFA codes.
Check actual live headers, not just repository configuration. Distinguish the
ordinary web popup from a redirect-resume flow (`oauthResume: true`), and check
for concurrent tabs overwriting shared resume state before proposing a fix.

For provider escalation, supply the environment, institution ID, product,
observation times, health breakdown, Link session IDs, and Plaid request IDs.
Include the Item ID only in an authorized private support channel. Do not send
access tokens or credentials. State separately what is observed, what is
inferred, and what remains unverified.

## References

- [Plaid Institutions API](https://plaid.com/docs/api/institutions/)
- [Institution status in Link](https://plaid.com/docs/link/institution-status/)
- [Link update mode](https://plaid.com/docs/link/update-mode/)
- [OAuth flows](https://plaid.com/docs/link/oauth/)
- [Item errors](https://plaid.com/docs/errors/item/)
- [Link web callbacks](https://plaid.com/docs/link/web/)
- [Finance background jobs](operations.md#finance-background-sync)
