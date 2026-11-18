#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
exec sh "$script_dir/../lib/nativeRelease.sh" ios upload staging "$@"
