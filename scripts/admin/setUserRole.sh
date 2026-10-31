#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EMAIL="${1:-}"
ROLE="${2:-}"
TARGET="${3:---remote}"

if [[ -z "$EMAIL" || -z "$ROLE" ]]; then
  echo "Usage: bun --bun run auth:set-role <email> <user|admin> [--remote|--local]" >&2
  exit 1
fi

if [[ "$ROLE" != "user" && "$ROLE" != "admin" ]]; then
  echo "ERROR: Role must be either user or admin." >&2
  exit 1
fi

if [[ "$TARGET" != "--remote" && "$TARGET" != "--local" ]]; then
  echo "ERROR: Target must be either --remote or --local." >&2
  exit 1
fi

if [[ "$TARGET" == "--remote" ]]; then
  # shellcheck source=scripts/lib/cloudflareEnv.sh
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../lib/cloudflareEnv.sh"
  load_cloudflare_env
fi

# The change is recorded in user_role_events with the operator who ran this
# script. Operators are not Balebase users: the event keeps the identity given
# here (by default the operator's Git identity), never a user account.
OPERATOR_NAME="${AUTH_OPERATOR_NAME:-$(git -C "$REPO_ROOT" config user.name || true)}"
OPERATOR_EMAIL="${AUTH_OPERATOR_EMAIL:-$(git -C "$REPO_ROOT" config user.email || true)}"
if [[ -z "${OPERATOR_NAME//[[:space:]]/}" ]]; then
  echo "ERROR: Name the operator with AUTH_OPERATOR_NAME or git config user.name." >&2
  exit 1
fi

sql_string() {
  printf "'%s'" "${1//\'/\'\'}"
}

email_sql="$(sql_string "$EMAIL")"
# One statement: the view's trigger records the event and changes the role
# together, and changes nothing when the user already has the role.
sql="INSERT INTO operator_role_changes (email, role, operator_name, operator_email) VALUES ($email_sql, $(sql_string "$ROLE"), $(sql_string "$OPERATOR_NAME"), $(sql_string "$OPERATOR_EMAIL")); SELECT \"email\", \"role\" FROM \"user\" WHERE \"email\" = $email_sql;"

cd "$REPO_ROOT/packages/api"
result="$(
  bunx --bun wrangler d1 execute DB "$TARGET" --json --command "$sql"
)"

if ! jq -e --arg email "$EMAIL" --arg role "$ROLE" \
  'any(.. | objects; .email? == $email and .role? == $role)' \
  >/dev/null <<<"$result"; then
  echo "ERROR: No user with email $EMAIL has the $ROLE role." >&2
  exit 1
fi

echo "$EMAIL has the $ROLE role in ${TARGET#--} D1. Changes are recorded in user_role_events."
