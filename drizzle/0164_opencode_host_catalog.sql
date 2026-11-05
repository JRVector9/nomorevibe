-- Store the actual catalog of an existing OpenCode host (M3 currently has 111 models).
-- Allow an OpenCode host URL and encrypted bridge-only credential; provider logins stay on that host.
-- Keep legacy local-CLI rows, other CLI limits, and ledger rules unchanged.
-- No credentials, ranks, capacity settings or model calls are created by this migration.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE ai_connections DROP CONSTRAINT ai_connections_cli_check;
--> statement-breakpoint
ALTER TABLE ai_connections ADD CONSTRAINT ai_connections_cli_check CHECK (
  kind <> 'cli' OR (cli_tool IN ('claude','codex','grok','opencode')
    AND ((base_url IS NULL AND api_key_ciphertext IS NULL)
      OR (cli_tool = 'opencode' AND base_url IS NOT NULL AND api_key_ciphertext IS NOT NULL))
    AND cardinality(cli_models) BETWEEN 1 AND CASE WHEN cli_tool = 'opencode' THEN 512 ELSE 32 END
    AND array_position(cli_models, NULL) IS NULL
    AND models IS NULL AND models_read_at IS NULL AND models_error IS NULL)
);
