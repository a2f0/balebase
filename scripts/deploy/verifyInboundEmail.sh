#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/cloudflareEnv.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/cloudflareEnv.sh"
DEPLOY_TIER="${DEPLOY_TIER:-prod}"
load_cloudflare_tier_env "$DEPLOY_TIER"
if [[ -z "${CLOUDFLARE_EMAIL_API_TOKEN:-}" ]]; then
  echo "ERROR: Missing CLOUDFLARE_EMAIL_API_TOKEN." >&2
  exit 1
fi
# The zone-scoped email token reads Email Routing; the account token reads DNS.
account_token="$CLOUDFLARE_API_TOKEN"
email_token="$CLOUDFLARE_EMAIL_API_TOKEN"

API_BASE="https://api.cloudflare.com/client/v4"
ZONE_NAME="balebase.com"
if [[ "$DEPLOY_TIER" == "staging" ]]; then
  INBOUND_DOMAIN="inbox-staging.balebase.com"
  PLATFORM_DOMAIN="$INBOUND_DOMAIN"
  api_config="wrangler.staging.jsonc"
  WORKER_NAME="balebase-api-staging"
else
  INBOUND_DOMAIN="inbox.balebase.com"
  PLATFORM_DOMAIN="$ZONE_NAME"
  api_config="wrangler.jsonc"
  WORKER_NAME="balebase-api"
fi

cloudflare_get() {
  local token="$1"
  shift
  curl -fsS "$@" -H "Authorization: Bearer $token"
}

# Cloudflare can route both addresses while D1 still rejects their envelopes.
# Only compare aggregate counts and the destination organization ID.
check_bindings() {
  local sql
  if [[ -z "${TF_VAR_platform_mailbox_organization_id:-}" ]]; then return 0; fi
  sql="SELECT count(*) AS recipients, count(DISTINCT box.organization_id) AS organizations, min(box.organization_id) AS organization_id
    FROM inbound_mailboxes box JOIN organization org ON org.id = box.organization_id
    WHERE box.disconnected_at IS NULL AND org.deletedAt IS NULL
      AND box.address IN ('legal@$PLATFORM_DOMAIN', 'privacy@$PLATFORM_DOMAIN')"
  if ! (
    cd "$SCRIPT_DIR/../../packages/api"
    bunx --bun --no-install wrangler d1 execute DB --remote --config "$api_config" --command "$sql" --json
  ) | jq -e --arg expected "$TF_VAR_platform_mailbox_organization_id" '.[0].results[0] | .recipients == 2 and .organizations == 1 and .organization_id == $expected' >/dev/null; then
    echo "ERROR: Connect both legal@$PLATFORM_DOMAIN and privacy@$PLATFORM_DOMAIN in the Balebase workspace, then rerun email verification." >&2
    exit 1
  fi
  if ! cloudflare_get "$account_token" "$API_BASE/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/settings" |
    jq -e --arg expected "$TF_VAR_platform_mailbox_organization_id" '.success == true and any(.result.bindings[]?; .name == "PLATFORM_MAILBOX_ORGANIZATION_ID" and .type == "plain_text" and .text == $expected)' >/dev/null; then
    echo "ERROR: Deploy $WORKER_NAME with the configured platform inbox organization before enabling its email routes." >&2
    exit 1
  fi
}
if [[ "${1:-}" == "--bindings-only" && -z "${TF_VAR_platform_mailbox_organization_id:-}" ]]; then
  exit 0
fi

zone_response="$(cloudflare_get "$email_token" "$API_BASE/zones?name=$ZONE_NAME")"
zone_id="$(jq -r '.result[0].id // empty' <<<"$zone_response")"

if [[ -z "$zone_id" ]]; then
  echo "ERROR: Cloudflare zone $ZONE_NAME was not found." >&2
  exit 1
fi

# The Email Routing DNS endpoint only describes the records a subdomain needs,
# and public resolvers negatively cache a subdomain that was checked before it
# existed, so read the zone's live MX records with the account token.
check_mx() {
  local domain="$1" mode="${2:-live}" mx_response
  mx_response="$(
    cloudflare_get "$account_token" --get "$API_BASE/zones/$zone_id/dns_records" \
      --data-urlencode "type=MX" \
      --data-urlencode "name=$domain"
  )"

  if ! jq -e --arg mode "$mode" '
      ["route1.mx.cloudflare.net","route2.mx.cloudflare.net","route3.mx.cloudflare.net"] as $expected |
      [.result[]?.content | ascii_downcase | rtrimstr(".")] as $actual |
      .success == true and (.result_info.total_count // ($actual | length)) == ($actual | length) and
      (if $mode == "before" then (($actual - $expected) | length) == 0
       else ($actual | sort) == $expected end)' >/dev/null <<<"$mx_response"; then
    echo "ERROR: Unexpected Email Routing MX records for $domain ($mode)." >&2
    exit 1
  fi
}
if [[ "${1:-}" == "--bindings-only" ]]; then
  check_bindings
  check_mx "$PLATFORM_DOMAIN" before
  exit 0
fi

check_mx "$INBOUND_DOMAIN"
if [[ -n "${TF_VAR_platform_mailbox_organization_id:-}" && "$PLATFORM_DOMAIN" != "$INBOUND_DOMAIN" ]]; then check_mx "$PLATFORM_DOMAIN"; fi

rules_response="$(
  cloudflare_get "$email_token" "$API_BASE/zones/$zone_id/email/routing/rules"
)"

addresses=("upload@$INBOUND_DOMAIN" "inbox@$INBOUND_DOMAIN")
if [[ -n "${TF_VAR_platform_mailbox_organization_id:-}" ]]; then
  addresses+=("legal@$PLATFORM_DOMAIN" "privacy@$PLATFORM_DOMAIN")
fi
for address in "${addresses[@]}"; do
  matching_rules="$(
    jq --arg address "$address" --arg worker "$WORKER_NAME" \
      '[.result[]? |
        select(.enabled == true) |
        select(any(.matchers[]?;
          .type == "literal" and .field == "to" and .value == $address)) |
        select(any(.actions[]?;
          .type == "worker" and any(.value[]?; . == $worker)))] |
       length' \
      <<<"$rules_response"
  )"

  if [[ "$matching_rules" -ne 1 ]]; then
    echo "ERROR: Expected one active route from $address to $WORKER_NAME." >&2
    exit 1
  fi
done

settings_response="$(
  cloudflare_get "$email_token" "$API_BASE/zones/$zone_id/email/routing"
)"
if ! jq -e \
  '(.success == true) and (.result.support_subaddress == true)' \
  >/dev/null <<<"$settings_response"; then
  echo "ERROR: Email Routing subaddressing is not enabled." >&2
  exit 1
fi

check_bindings

echo "PASS: $INBOUND_DOMAIN has its three Cloudflare Email Routing MX records."
echo "PASS: ${addresses[*]} route to $WORKER_NAME."
if [[ -n "${TF_VAR_platform_mailbox_organization_id:-}" ]]; then
  echo "PASS: Both platform addresses have active inboxes in the configured Balebase organization."
fi
