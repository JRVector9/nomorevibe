CREATE TABLE uptime_control (
 id integer PRIMARY KEY DEFAULT 1 CHECK (id=1),
 observations_enabled boolean NOT NULL DEFAULT false,
 gate_enabled boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
 sources jsonb NOT NULL DEFAULT '[]',
 CHECK (NOT gate_enabled OR observations_enabled)
);
--> statement-breakpoint
INSERT INTO uptime_control (id) VALUES (1);
--> statement-breakpoint
CREATE TABLE uptime_observations (
 observation_id uuid PRIMARY KEY, product_id integer NOT NULL, slug varchar(80) NOT NULL,
 url text NOT NULL, url_hash varchar(64) NOT NULL,
 slot timestamp(3) with time zone NOT NULL, started_at timestamp(3) with time zone NOT NULL,
 observed_at timestamp(3) with time zone NOT NULL,
 host varchar(24) NOT NULL, instance_id varchar(120) NOT NULL, region varchar(120) NOT NULL,
 kind varchar(12) NOT NULL, status integer NOT NULL, latency_ms integer,
 payload_hash varchar(64) NOT NULL, disposition varchar(20) NOT NULL, reason varchar(64),
 revision bigint NOT NULL, received_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uptime_observations_status CHECK ((kind='http' AND status BETWEEN 100 AND 599) OR (kind IN ('timeout','dns','network','unknown') AND status=0)),
 CONSTRAINT uptime_observations_time CHECK (observed_at>=started_at AND extract(epoch FROM slot) % 21600=0 AND started_at>=slot AND started_at<slot+interval '6 hours'),
 CONSTRAINT uptime_observations_host CHECK (host IN ('m3','mini','oracle-osaka-smoke') AND (host<>'oracle-osaka-smoke' OR region='ap-osaka-1')),
 CONSTRAINT uptime_observations_hash CHECK (url_hash ~ '^[a-f0-9]{64}$' AND payload_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT uptime_observations_disposition CHECK (disposition IN ('raw_only','applied','observation_hold','stale'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX uptime_observations_slot_idx ON uptime_observations(product_id,url_hash,slot,host);
--> statement-breakpoint
CREATE INDEX uptime_observations_evidence_idx ON uptime_observations(observed_at,host);
--> statement-breakpoint
CREATE TABLE uptime_gates (
 product_id integer PRIMARY KEY, url text NOT NULL, product_updated_at timestamp NOT NULL,
 revision bigint NOT NULL, policy_version varchar(32), state varchar(20) NOT NULL, reason varchar(64),
 last_observation_id uuid NOT NULL, last_observed_at timestamp(3) with time zone NOT NULL,
 applied_observation_id uuid, health_checked_at timestamp(3), failures integer NOT NULL DEFAULT 0,
 status integer, next_check_at timestamp(3) with time zone NOT NULL,
 recheck_requested_at timestamp with time zone
);
--> statement-breakpoint
CREATE FUNCTION uptime_observations_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'uptime_observations_append_only' USING ERRCODE='55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER uptime_observations_no_change BEFORE UPDATE OR DELETE ON uptime_observations
 FOR EACH STATEMENT EXECUTE FUNCTION uptime_observations_reject_change();
--> statement-breakpoint
CREATE TRIGGER uptime_observations_no_truncate BEFORE TRUNCATE ON uptime_observations
 FOR EACH STATEMENT EXECUTE FUNCTION uptime_observations_reject_change();
--> statement-breakpoint
ALTER TABLE uptime_observations ENABLE ALWAYS TRIGGER uptime_observations_no_change;
--> statement-breakpoint
ALTER TABLE uptime_observations ENABLE ALWAYS TRIGGER uptime_observations_no_truncate;
