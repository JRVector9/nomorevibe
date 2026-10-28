-- Separate staging-only principal. Creating/granting the principal and enabling the control require the release runbook.
CREATE TABLE github_ko_discovery_control (
 id integer PRIMARY KEY CHECK (id = 1), enabled boolean NOT NULL DEFAULT false,
 start_at timestamp, queries jsonb NOT NULL DEFAULT '[{"label":"한국어 README 있습니다","query":"있습니다 in:readme","priority":60},{"label":"한국어 README 합니다","query":"합니다 in:readme","priority":60},{"label":"한국어 README 소개","query":"한국어 in:readme","priority":55}]',
 shared_cursor jsonb, epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
 updated_at timestamp NOT NULL DEFAULT now(),
 CHECK (NOT enabled OR start_at IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO github_ko_discovery_control (id) VALUES (1);
--> statement-breakpoint
CREATE TABLE github_ko_discovery_queries (
 label text PRIMARY KEY CHECK (length(label) BETWEEN 1 AND 40),
 query text NOT NULL CHECK (length(query) BETWEEN 1 AND 200), priority integer NOT NULL CHECK (priority BETWEEN 0 AND 1000),
 enabled boolean NOT NULL DEFAULT true, transferred boolean NOT NULL DEFAULT false,
 cursor jsonb, legacy_state jsonb, config_hash text NOT NULL,
 token uuid, lease_until timestamp, epoch integer NOT NULL DEFAULT 0,
 due_at timestamp NOT NULL DEFAULT now(), last_error text, updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX github_ko_discovery_queries_due ON github_ko_discovery_queries (due_at, label) WHERE enabled;
--> statement-breakpoint
CREATE TABLE github_ko_discovery_staging (
 repo text PRIMARY KEY CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' AND repo = lower(repo)),
 signal text NOT NULL CHECK (length(signal) BETWEEN 1 AND 40), priority integer NOT NULL CHECK (priority BETWEEN 0 AND 1000),
 description text, language text NOT NULL DEFAULT 'unknown' CHECK (language IN ('yes', 'no', 'unknown')),
 evidence jsonb NOT NULL DEFAULT '{}', state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'excluded')),
 checked_at timestamp, due_at timestamp NOT NULL DEFAULT now(), discovered_at timestamp NOT NULL DEFAULT now(),
 updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX github_ko_discovery_staging_due ON github_ko_discovery_staging (due_at, repo) WHERE state = 'pending';
--> statement-breakpoint
-- Query/control configuration and applied state are never writable by the Oracle principal.
-- Restrict generic observation writes in addition to column grants.
CREATE FUNCTION oracle_korean_observation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user::text = 'nomorevibe_oracle_github_ko'
  AND NEW.key !~ '^(github-ko-discovery|service:crawler):github-ko-discovery-consumer-[A-Za-z0-9._-]{1,19}$'
  AND NOT coalesce((NEW.key ~ '^discovery-progress:korean:[a-f0-9]{16}:[a-f0-9]{24}$'
    AND NEW.value->>'lane'='korean' AND NEW.value->>'worker' ~ '^github-ko-discovery-consumer-[A-Za-z0-9._-]{1,19}$'
    AND split_part(NEW.key,':',3)=left(encode(sha256(convert_to(NEW.value->>'worker','UTF8')),'hex'),16)
    AND split_part(NEW.key,':',4)=left(encode(sha256(convert_to(NEW.value->>'signal','UTF8')),'hex'),24)),false) THEN
  RAISE EXCEPTION 'oracle_korean_observation_key' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operations_observations_oracle_korean_scope BEFORE INSERT OR UPDATE ON operations_observations
 FOR EACH ROW EXECUTE FUNCTION oracle_korean_observation_scope();
--> statement-breakpoint
-- Oracle may reuse public repository pages; it cannot read/overwrite private visibility or commit-search pages.
ALTER TABLE github_discovery_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY github_discovery_pages_all ON github_discovery_pages AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY github_discovery_pages_oracle_ko ON github_discovery_pages AS RESTRICTIVE FOR ALL TO PUBLIC
 USING (current_user::text <> 'nomorevibe_oracle_github_ko' OR (scope='public-v1' AND kind='repositories' AND query LIKE '% is:public %'))
 WITH CHECK (current_user::text <> 'nomorevibe_oracle_github_ko' OR (scope='public-v1' AND kind='repositories' AND query LIKE '% is:public %'));
--> statement-breakpoint
-- Control edits fence in-flight page owners; updating the bounded shared-page cursor does not change ownership.
CREATE FUNCTION korean_discovery_control_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.start_at IS DISTINCT FROM OLD.start_at OR NEW.queries IS DISTINCT FROM OLD.queries THEN
  NEW.epoch := OLD.epoch + 1;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER github_ko_control_epoch BEFORE UPDATE ON github_ko_discovery_control
 FOR EACH ROW EXECUTE FUNCTION korean_discovery_control_epoch();
