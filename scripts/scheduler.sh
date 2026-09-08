#!/bin/sh
# Compatibility entrypoint for the independent DB scheduler. Requires the worker image/runtime.
# BASE_URL / CRON_SECRET are no longer used: the web service is not part of scheduling.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."
for arg in "$@"; do
  case "$arg" in
    --interval-seconds=*) exec node --import tsx "$SCRIPT_DIR/scheduler.ts" "$@" ;;
  esac
done
exec node --import tsx "$SCRIPT_DIR/scheduler.ts" "--interval-seconds=${TICK_SECONDS:-10}" "$@"
