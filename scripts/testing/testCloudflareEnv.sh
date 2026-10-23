#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Git hooks, including pre-push, export repository variables such as GIT_DIR.
# Clear them so Git resolves the fixture as its own repository and never
# initializes this checkout or reads its real .secrets link.
while IFS= read -r git_variable; do
  unset "$git_variable"
done < <(git rev-parse --local-env-vars)

# The fixture is its own Git repository outside this checkout, so the loaders
# resolve it as the repository root.
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/cloudflare-env-test.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/scripts/dev" "$FIXTURE/scripts/lib" "$FIXTURE/packages/api" "$FIXTURE/bin" \
  "$FIXTURE/.secrets/prod"
cp "$REPO_ROOT/scripts/lib/cloudflareEnv.sh" "$FIXTURE/scripts/lib/"
cp "$REPO_ROOT/scripts/dev/devApi.sh" "$FIXTURE/scripts/dev/"
git init -q "$FIXTURE"
fixture_root="$(cd "$FIXTURE" && pwd -P)"
[[ "$(cd "$FIXTURE" && git rev-parse --show-toplevel)" == "$fixture_root" ]] || {
  echo 'The fixture does not resolve as its own Git repository' >&2
  exit 1
}

cat > "$FIXTURE/.secrets/prod/shared.env" <<'EOF'
TF_VAR_cloudflare_api_token=shared-token
TF_VAR_cloudflare_account_id=shared-account
CLOUDFLARE_EMAIL_API_TOKEN=shared-email-token
EOF
cat > "$FIXTURE/.secrets/prod/app.env" <<'EOF'
TF_VAR_cloudflare_api_token=prod-token
BETTER_AUTH_SECRET=prod-auth
CHECKR_API_KEY=prod-checkr
PLAID_CLIENT_ID=prod-plaid-client
PLAID_SECRET=prod-plaid-secret
PLAID_TOKEN_ENCRYPTION_KEY=prod-plaid-key
EOF
# A file left over from the flat layout must never be read.
printf 'TF_VAR_cloudflare_api_token=legacy-token\n' > "$FIXTURE/.secrets/root.env"

cat > "$FIXTURE/probe.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
unset TF_VAR_cloudflare_api_token TF_VAR_cloudflare_account_id \
  CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL_API_TOKEN \
  BETTER_AUTH_SECRET CHECKR_API_KEY CHECKR_BACKGROUND_PACKAGE \
  PLAID_CLIENT_ID PLAID_SECRET \
  PLAID_TOKEN_ENCRYPTION_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
  STRIPE_PRO_PRICE_ID STRIPE_PORTAL_CONFIGURATION_ID \
  STRIPE_PRO_LEGACY_PRICE_IDS STRIPE_PUBLISHABLE_KEY
if [[ "$1" == "devApi" ]]; then
  exec bash scripts/dev/devApi.sh
fi
# shellcheck source=/dev/null
source scripts/lib/cloudflareEnv.sh
"$@"
printf 'tf_token=%s tf_account=%s token=%s account=%s auth=%s\n' \
  "${TF_VAR_cloudflare_api_token:-}" "${TF_VAR_cloudflare_account_id:-}" \
  "${CLOUDFLARE_API_TOKEN:-}" "${CLOUDFLARE_ACCOUNT_ID:-}" \
  "${BETTER_AUTH_SECRET:-}"
EOF
# Without a template, macOS mktemp ignores TMPDIR; keep the local API's
# temporary env file inside the fixture.
REAL_MKTEMP="$(command -v mktemp)"
export REAL_MKTEMP FIXTURE
cat > "$FIXTURE/bin/mktemp" <<'EOF'
#!/usr/bin/env bash
if [[ $# -eq 0 ]]; then
  exec "$REAL_MKTEMP" "$FIXTURE/tmp.XXXXXX"
fi
exec "$REAL_MKTEMP" "$@"
EOF
cat > "$FIXTURE/bin/bunx" <<'EOF'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--env-file" ]]; then
    cat "$2" >> "$MOCK_LOG"
    shift
  elif [[ "$1" == "--var" ]]; then
    printf 'var %s\n' "$2" >> "$MOCK_LOG"
    shift
  fi
  shift
done
EOF
chmod +x "$FIXTURE/bin/mktemp" "$FIXTURE/bin/bunx"
export MOCK_LOG="$FIXTURE/commands.log"

probe() {
  (cd "$FIXTURE" && PATH="$FIXTURE/bin:$PATH" bash probe.sh "$@")
}

expect_output() {
  local expected="$1"
  shift
  local actual
  actual="$(probe "$@")"
  [[ "$actual" == "$expected" ]] || {
    printf 'Expected %s to print:\n  %s\nGot:\n  %s\n' "$*" "$expected" "$actual" >&2
    exit 1
  }
}

expect_failure() {
  local message="$1"
  shift
  local output
  if output="$(probe "$@" 2>&1)"; then
    echo "Expected $* to fail" >&2
    exit 1
  fi
  [[ "$output" == *"$message"* ]] || {
    printf 'Expected %s to report "%s", got:\n%s\n' "$*" "$message" "$output" >&2
    exit 1
  }
}

expect_dev_env() {
  local expected="$1"
  : > "$MOCK_LOG"
  probe devApi
  [[ "$(LC_ALL=C sort "$MOCK_LOG")" == "$expected" ]] || {
    printf 'Unexpected local API environment:\n%s\n' "$(LC_ALL=C sort "$MOCK_LOG")" >&2
    exit 1
  }
}

# Production commands read prod/shared.env, then prod/app.env.
expect_output \
  'tf_token=prod-token tf_account=shared-account token=prod-token account=shared-account auth=prod-auth' \
  load_cloudflare_env
expect_output \
  'tf_token=prod-token tf_account=shared-account token=shared-email-token account= auth=prod-auth' \
  load_cloudflare_email_env

# Each tier is self-contained and needs its app.env.
expect_failure '.secrets/staging/app.env is missing.' load_tier_env staging
expect_failure 'Unknown secrets tier: dev' load_tier_env dev

# Local development reads the production tier but runs Checkr staging and
# Plaid Sandbox. Their credentials come only from the staging tier, when this
# checkout has one, so the production Plaid secret never reaches it.
dev_vars="$(printf '%s\n' \
  'var CHECKR_ENV:staging' \
  'var PLAID_ENV:sandbox' \
  'var STRIPE_PORTAL_CONFIGURATION_ID:' \
  'var STRIPE_PRO_LEGACY_PRICE_IDS:' \
  'var STRIPE_PRO_PRICE_ID:' \
  'var STRIPE_PUBLISHABLE_KEY:')"
expect_dev_env "$(printf '%s\n' \
  BETTER_AUTH_SECRET=prod-auth \
  BETTER_AUTH_URL=http://localhost:8787 \
  CORS_ORIGIN=http://localhost:5173 \
  PLAID_TOKEN_ENCRYPTION_KEY=prod-plaid-key \
  "$dev_vars")"

mkdir -p "$FIXTURE/.secrets/staging"
cat > "$FIXTURE/.secrets/staging/shared.env" <<'EOF'
CHECKR_API_KEY=shared-checkr
CHECKR_BACKGROUND_PACKAGE=shared-background
EOF
cat > "$FIXTURE/.secrets/staging/app.env" <<'EOF'
BETTER_AUTH_SECRET=staging-auth
CHECKR_API_KEY=staging-checkr
PLAID_CLIENT_ID=sandbox-plaid-client
PLAID_SECRET=sandbox-plaid-secret
EOF
expect_dev_env "$(printf '%s\n' \
  BETTER_AUTH_SECRET=prod-auth \
  BETTER_AUTH_URL=http://localhost:8787 \
  CHECKR_API_KEY=staging-checkr \
  CHECKR_BACKGROUND_PACKAGE=shared-background \
  CORS_ORIGIN=http://localhost:5173 \
  PLAID_CLIENT_ID=sandbox-plaid-client \
  PLAID_SECRET=sandbox-plaid-secret \
  PLAID_TOKEN_ENCRYPTION_KEY=prod-plaid-key \
  "$dev_vars")"

# shared.env is optional.
rm "$FIXTURE/.secrets/prod/shared.env"
expect_output \
  'tf_token=prod-token tf_account= token= account= auth=prod-auth' \
  load_tier_env prod
expect_failure 'Missing required Cloudflare variables' load_cloudflare_env

# A malformed line stops the caller instead of loading partial credentials.
printf '%s\n' TF_VAR_cloudflare_account_id=shared-account not-an-assignment \
  > "$FIXTURE/.secrets/prod/shared.env"
expect_failure 'not-an-assignment' load_cloudflare_env

echo 'Secrets tier loading checks passed.'
