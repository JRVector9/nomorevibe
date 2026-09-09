CREATE TABLE operations_observations (key varchar(80) PRIMARY KEY, value jsonb NOT NULL, observed_at timestamp NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE TABLE category_decisions (repo varchar(200) PRIMARY KEY, source_hash varchar(64) NOT NULL, category varchar(40), reason text NOT NULL, actor varchar(120) NOT NULL, revision integer NOT NULL DEFAULT 1, retry_at timestamp NOT NULL, updated_at timestamp NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE TABLE operations_audit (id serial PRIMARY KEY, actor varchar(120) NOT NULL, action varchar(80) NOT NULL, target varchar(200) NOT NULL, detail jsonb NOT NULL, created_at timestamp NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE INDEX operations_audit_created_idx ON operations_audit(created_at DESC);
