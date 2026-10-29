-- Engine connections from the admin (no deploy).
-- 1) transport: 'direct' marks a contract whose endpoint is the engine itself, not the abcLLM gateway. Only then may a response
--    without the gateway's usage_provenance be terminal; the default keeps every existing row on the gateway rules.
-- 2) model_registry_overrides: an enabled row replaces the code-default registry definition of the same key (equipment,
--    address, engine model name, limits). The app validates the merged registry before saving; the DB pins the key identity.
ALTER TABLE model_serving_contracts ADD COLUMN transport varchar(16) NOT NULL DEFAULT 'gateway';
--> statement-breakpoint
ALTER TABLE model_serving_contracts ADD CONSTRAINT model_serving_contracts_transport_check CHECK (transport IN ('gateway','direct'));
--> statement-breakpoint
CREATE TABLE model_registry_overrides (
  id bigserial PRIMARY KEY,
  key varchar(120) NOT NULL,
  definition jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  note varchar(400),
  updated_by varchar(120) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_registry_overrides_identity_check CHECK (jsonb_typeof(definition) = 'object' AND definition->>'key' = key)
);
--> statement-breakpoint
CREATE UNIQUE INDEX model_registry_overrides_enabled_idx ON model_registry_overrides (key) WHERE enabled;
