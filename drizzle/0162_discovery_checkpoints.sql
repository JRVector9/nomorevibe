-- Additive receipts only. Old timestamps are not backfilled as successful discovery.
CREATE TABLE discovery_checkpoints (
 source varchar(24) NOT NULL CHECK (source IN ('github-latest','github-full','show-hn','korean-query','korean-shared','korean-language','korean-apply')),
 subject varchar(64) NOT NULL CHECK (subject ~ '^[a-f0-9]{64}$'),
 slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 127),
 generation varchar(64) NOT NULL CHECK (generation ~ '^[a-f0-9]{64}$'),
 semantic varchar(64) NOT NULL CHECK (semantic ~ '^[a-f0-9]{64}$'),
 reference varchar(200),
 intent varchar(24) NOT NULL CHECK (intent IN ('ready','caught_up','queue_cap','rate_cap','backoff','upstream_error','no_work','measurement_unknown')),
 resume_at timestamp,
 revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
 first_seen_at timestamp NOT NULL DEFAULT now(), progress_at timestamp, acknowledged_at timestamp,
 recorded_at timestamp NOT NULL DEFAULT now(), PRIMARY KEY(source,subject),
 CHECK (reference IS NULL OR reference ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
);
--> statement-breakpoint
CREATE INDEX discovery_checkpoints_retention ON discovery_checkpoints(recorded_at);
--> statement-breakpoint
-- At most 128 subjects per source / 896 rows total, including retired subjects.
CREATE UNIQUE INDEX discovery_checkpoints_slots ON discovery_checkpoints(source,slot);
--> statement-breakpoint
CREATE INDEX github_discovery_pages_public_reuse ON github_discovery_pages(completed_at,key)
 WHERE state='complete' AND kind='repositories' AND scope='public-v1';
--> statement-breakpoint
ALTER TABLE discovery_checkpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY discovery_checkpoints_runtime ON discovery_checkpoints AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY discovery_checkpoints_oracle_ko ON discovery_checkpoints AS RESTRICTIVE FOR ALL TO PUBLIC
 USING (current_user::text <> 'nomorevibe_oracle_github_ko' OR source IN ('korean-query','korean-shared','korean-language'))
 WITH CHECK (current_user::text <> 'nomorevibe_oracle_github_ko' OR source IN ('korean-query','korean-shared','korean-language'));
--> statement-breakpoint
-- Existing provisioned principal only; provisioning remains the separate operator procedure.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nomorevibe_oracle_github_ko') THEN
  GRANT SELECT,INSERT ON discovery_checkpoints TO nomorevibe_oracle_github_ko;
  GRANT UPDATE(generation,semantic,reference,intent,resume_at,revision,first_seen_at,progress_at,acknowledged_at,recorded_at)
    ON discovery_checkpoints TO nomorevibe_oracle_github_ko;
 END IF;
END $$;
