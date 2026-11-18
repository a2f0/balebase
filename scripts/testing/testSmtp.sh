#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
venv="$(mktemp -d)"
trap 'rm -rf -- "$venv"' EXIT
python3 -m venv "$venv"
"$venv/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: --require-hashes -r "$repo/smtp/requirements.txt" >/dev/null
bun "$repo/packages/api/scripts/smtpIntegration.ts" "$venv/bin/python"
