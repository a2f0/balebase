#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$repo_root/.scope/local.env" ]]; then
  set -a
  # Local developer configuration, including the container endpoint and tokens.
  # shellcheck disable=SC1091
  source "$repo_root/.scope/local.env"
  set +a
fi

scope_dir="${SCOPE_SOURCE_DIR:-$HOME/.local/share/scope/source}"
scope_install_dir="${SCOPE_INSTALL_DIR:-$HOME/.local/bin}"
scope_revision=16544702d9dd4f0f5a7991fa4dbdf07a9247fedc

install_scope() {
  if [[ ! -d "$scope_dir/.git" ]]; then
    git clone https://github.com/microsoft/scope.git "$scope_dir"
  fi
  if [[ -n "$(git -C "$scope_dir" status --porcelain)" ]]; then
    echo "Scope source has local changes: $scope_dir" >&2
    exit 1
  fi
  if [[ "$(git -C "$scope_dir" rev-parse HEAD)" != "$scope_revision" ]]; then
    git -C "$scope_dir" fetch origin "$scope_revision"
    git -C "$scope_dir" checkout --detach "$scope_revision"
  fi
  pnpm --dir "$scope_dir" --filter cli... install --frozen-lockfile
  pnpm --dir "$scope_dir" build:cli
  mkdir -p "$scope_install_dir"
  install -m 755 "$scope_dir/apps/cli/dist/scope.mjs" "$scope_install_dir/scope"
  "$scope_install_dir/scope" --version
}

if [[ "${1:-}" == install ]]; then
  install_scope
  exit
fi

if [[ "${1:-}" != down && "${1:-}" != status ]]; then
  if [[ ! -f "$scope_dir/apps/cli/dist/scope.mjs" ]] ||
    [[ "$(git -C "$scope_dir" rev-parse HEAD 2>/dev/null || true)" != "$scope_revision" ]]; then
    echo 'Scope is missing or uses a different revision. Run bun run scope:install.' >&2
    exit 1
  fi
fi
if [[ "${1:-}" == up && -n "$(git -C "$scope_dir" status --porcelain)" ]]; then
  echo "Scope source has local changes: $scope_dir" >&2
  exit 1
fi

export SCOPE_API_URL="${SCOPE_API_URL:-http://127.0.0.1:3100}"

if [[ "${1:-}" == up && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" &&
  -z "${ANTHROPIC_API_KEY:-}" &&
  -n "${SCOPE_CLAUDE_CREDENTIALS_FILE:-}" ]]; then
  # Read the existing login at startup so tokens are never copied into the repo.
  CLAUDE_CODE_OAUTH_TOKEN="$(bun -e '
    const file = Bun.file(process.argv[1]);
    if (!await file.exists()) {
      throw new Error("Claude credential file is missing; use claude setup-token instead.");
    }
    const { claudeAiOauth: oauth } = await file.json();
    if (!oauth?.accessToken || !Number.isFinite(oauth.expiresAt) ||
        oauth.expiresAt <= Date.now() + 300_000) {
      throw new Error("Claude login is missing or expired; refresh it with Claude Code.");
    }
    process.stdout.write(oauth.accessToken);
  ' "$SCOPE_CLAUDE_CREDENTIALS_FILE")"
  export CLAUDE_CODE_OAUTH_TOKEN
fi

case "${1:-}" in
  up|down|status)
    action="$1"
    shift
    cd "$scope_dir"
    export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
    compose=(docker compose --project-name balebase-scope
      --env-file .env.base
      --env-file apps/workers/coder-acp-claude-code/versions.env
      -f docker-compose.yml -f "$repo_root/scripts/dev/scopeCompose.yaml"
      --profile mongodb --profile claude-code)
    case "$action" in
      up) "${compose[@]}" up --detach --build "$@" ;;
      down) "${compose[@]}" down "$@" ;;
      status) "${compose[@]}" ps "$@" ;;
    esac
    ;;
  *) exec node "$scope_dir/apps/cli/dist/scope.mjs" "$@" ;;
esac
