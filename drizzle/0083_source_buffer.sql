CREATE TABLE crawl_source_buffer_control (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version = 1),
  blocked boolean NOT NULL DEFAULT false,
  last_decision_at timestamptz(3),
  last_reason varchar(30) NOT NULL DEFAULT 'unobserved'
    CHECK (last_reason IN ('unobserved','ready','count_pressure','measurement_unknown'))
);
--> statement-breakpoint
INSERT INTO crawl_source_buffer_control(id) VALUES(1);
