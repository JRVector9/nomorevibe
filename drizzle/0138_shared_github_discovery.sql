CREATE TABLE github_discovery_pages (
  key varchar(64) PRIMARY KEY,
  kind varchar(20) NOT NULL CHECK (kind IN ('commits','repositories')),
  query text NOT NULL,
  sort varchar(20) NOT NULL CHECK (sort IN ('recent','relevance')),
  page integer NOT NULL CHECK (page BETWEEN 1 AND 10),
  scope varchar(120) NOT NULL,
  generation varchar(120) NOT NULL,
  state varchar(20) NOT NULL CHECK (state IN ('running','complete')),
  owner uuid NOT NULL,
  owner_name varchar(120) NOT NULL,
  lease_until timestamp NOT NULL,
  result jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  CONSTRAINT github_discovery_pages_result_check CHECK (
    (state='running' AND result IS NULL AND completed_at IS NULL)
    OR (state='complete' AND result IS NOT NULL AND completed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX github_discovery_pages_state_idx ON github_discovery_pages (state, lease_until);
--> statement-breakpoint
CREATE INDEX github_discovery_pages_completed_idx ON github_discovery_pages (completed_at);
--> statement-breakpoint
CREATE INDEX github_discovery_pages_retention_idx ON github_discovery_pages (updated_at);
