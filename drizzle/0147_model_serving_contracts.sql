-- Admin-managed gateway serving contracts (no deploy). An enabled row overrides the ABCLLM_SERVING_CONTRACTS entry for the
-- same route+model; processes re-read enabled rows on a short interval. The app validates the contract JSON with the route's
-- strict schema; the DB pins identity, hash shape and the auth/key pairing. API keys are stored encrypted, never in the contract.
CREATE TABLE model_serving_contracts (
  id bigserial PRIMARY KEY,
  route_id varchar(64) NOT NULL,
  model varchar(200) NOT NULL,
  contract jsonb NOT NULL,
  contract_hash varchar(64) NOT NULL,
  auth varchar(16) NOT NULL DEFAULT 'gateway',
  api_key_ciphertext text,
  enabled boolean NOT NULL DEFAULT true,
  note varchar(400),
  updated_by varchar(120) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT model_serving_contracts_identity_check CHECK (jsonb_typeof(contract) = 'object' AND contract->>'routeId' = route_id AND contract->>'model' = model),
  CONSTRAINT model_serving_contracts_hash_check CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT model_serving_contracts_auth_check CHECK (auth IN ('gateway','none','stored') AND (auth = 'stored') = (api_key_ciphertext IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX model_serving_contracts_enabled_idx ON model_serving_contracts (route_id, model) WHERE enabled;
