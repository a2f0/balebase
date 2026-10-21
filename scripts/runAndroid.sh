#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
cd "$SCRIPT_DIR/../packages/app-capacitor" || exit 1

# The bundle talks to the hosted production API unless VITE_API_URL and
# VITE_APP_URL (or packages/app-capacitor/.env.local) point elsewhere.
bun run build
bun run cap:sync
exec bun run cap:run:android "$@"
