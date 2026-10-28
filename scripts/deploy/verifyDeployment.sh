#!/usr/bin/env bash

set -euo pipefail

# Check a tier's public URLs. DEPLOY_TIER is prod (the default) or staging.
DEPLOY_TIER="${DEPLOY_TIER:-prod}"
VERIFY_DOH_URL="${VERIFY_DOH_URL-https://cloudflare-dns.com/dns-query}"

case "$DEPLOY_TIER" in
  prod)
    API_URL="https://api.balebase.com"
    APP_URL="https://app.balebase.com"
    WEBSITE_URL="https://balebase.com"
    ;;
  staging)
    API_URL="https://api-staging.balebase.com"
    APP_URL="https://app-staging.balebase.com"
    WEBSITE_URL="https://website-staging.balebase.com"
    ;;
  *)
    echo "ERROR: Unknown deployment tier: $DEPLOY_TIER" >&2
    exit 1
    ;;
esac

curl_args=(--connect-timeout 10 --max-time 30 --silent --show-error)
# Fresh custom domains can be negatively cached by the local resolver even
# after Cloudflare's public DNS serves them. An empty value disables DoH.
if [[ -n "$VERIFY_DOH_URL" ]]; then
  curl_args+=(--doh-url "$VERIFY_DOH_URL")
fi
retry_args=(
  --fail
  --retry 10
  --retry-all-errors
  --retry-delay 3
  --retry-max-time 120
)

verify_url() {
  local label="$1"
  local url="$2"

  echo "Checking $label at $url..."
  curl "${curl_args[@]}" "${retry_args[@]}" --output /dev/null "$url"
  echo "PASS: $label is reachable."
}

verify_cors_headers() {
  local label="$1"
  local headers="$2"
  local normalized_headers

  # curl includes every attempt when --retry is used; inspect the final one.
  normalized_headers="$(tr -d '\r' <<<"$headers" |
    tr '[:upper:]' '[:lower:]' |
    awk '/^http\// { last_response = "" } { last_response = last_response $0 ORS } END { printf "%s", last_response }')"
  if ! grep -Fqx "access-control-allow-origin: $APP_URL" \
    <<<"$normalized_headers" ||
    ! grep -Fqx 'access-control-allow-credentials: true' \
      <<<"$normalized_headers"; then
    echo "FAIL: $label lacks credentialed app CORS headers." >&2
    return 1
  fi
  echo "PASS: $label allows credentialed requests from the app."
}

verify_auth_cors() {
  local method="$1"
  local headers
  local request_args=(--dump-header - --output /dev/null --header "Origin: $APP_URL")

  if [[ "$method" == "OPTIONS" ]]; then
    request_args+=(
      --request OPTIONS
      --header "Access-Control-Request-Method: GET"
    )
  fi

  echo "Checking $method auth session CORS..."
  headers="$(curl "${curl_args[@]}" "${retry_args[@]}" "${request_args[@]}" \
    "$API_URL/api/auth/get-session")"
  verify_cors_headers "$method auth session response" "$headers"
}

verify_edge_error_cors() {
  local response
  local headers
  local status

  # Cloudflare documents this as a test endpoint for its own 522 response.
  echo "Checking Cloudflare edge error CORS..."
  response="$(curl "${curl_args[@]}" --dump-header - --output /dev/null \
    --write-out $'\n%{http_code}' --header "Origin: $APP_URL" \
    "$API_URL/cdn-cgi/error/522")"
  status="${response##*$'\n'}"
  headers="${response%$'\n'*}"
  if [[ "$status" != "522" ]]; then
    echo "FAIL: Expected Cloudflare test error 522; received $status." >&2
    return 1
  fi
  verify_cors_headers "Cloudflare edge error response" "$headers"
}

verify_url "API" "$API_URL/health"
verify_auth_cors GET
verify_auth_cors OPTIONS
# Only the production stack owns the zone's response-header ruleset, which adds
# CORS headers to Cloudflare-generated API errors.
if [[ "$DEPLOY_TIER" == "prod" ]]; then
  verify_edge_error_cors
fi
verify_url "app" "$APP_URL"
verify_url "website" "$WEBSITE_URL"
verify_url "privacy policy" "$WEBSITE_URL/privacy/"
verify_url "terms of service" "$WEBSITE_URL/terms/"
verify_url "data retention policy" "$WEBSITE_URL/data-retention/"
