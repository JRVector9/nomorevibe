#!/bin/sh
set -u

# The publisher image has no persistent keychain. Seed Codex's ephemeral auth store
# from a deployment secret, then remove the raw secret from the worker environment.
codex_cli=${CODEX_CLI:-codex}
authenticated=false
if [ -n "${CODEX_ACCESS_TOKEN:-}" ]; then
  if printf '%s' "$CODEX_ACCESS_TOKEN" | "$codex_cli" login --with-access-token >/dev/null; then
    authenticated=true
  elif [ -n "${OPENAI_API_KEY:-}" ]; then
    echo "codex access-token authentication failed; trying the API-key fallback" >&2
  else
    echo "codex authentication failed; category classification will use its rule fallback" >&2
  fi
fi
if [ "$authenticated" = false ] && [ -n "${OPENAI_API_KEY:-}" ]; then
  if ! printf '%s' "$OPENAI_API_KEY" | "$codex_cli" login --with-api-key >/dev/null; then
    echo "codex authentication failed; category classification will use its rule fallback" >&2
  fi
fi

unset CODEX_ACCESS_TOKEN OPENAI_API_KEY
exec "$@"
