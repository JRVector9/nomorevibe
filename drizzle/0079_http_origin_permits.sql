CREATE TABLE http_origin_control (
 id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),
 mode text NOT NULL DEFAULT 'disabled' CHECK(mode IN ('disabled','open','draining')),
 epoch bigint NOT NULL DEFAULT 1 CHECK(epoch BETWEEN 1 AND 9007199254740991),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 policy jsonb, policy_hash text CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CHECK((policy IS NULL)=(policy_hash IS NULL)), CHECK(mode='disabled' OR policy IS NOT NULL)
);
INSERT INTO http_origin_control(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE http_origin_hops (
 id uuid PRIMARY KEY, token uuid NOT NULL UNIQUE, instance_id varchar(120) NOT NULL, boot_id uuid NOT NULL,
 host_id varchar(120) NOT NULL, origin text NOT NULL,
 epoch bigint NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('reserved','dispatched','indeterminate','released','cancelled')),
 reserved_until timestamptz(3) NOT NULL, dispatched_at timestamptz(3), settled_at timestamptz(3),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CHECK((state IN ('dispatched','indeterminate','released')) = (dispatched_at IS NOT NULL)),
 CHECK((state IN ('released','cancelled')) = (settled_at IS NOT NULL))
);
CREATE INDEX http_origin_hops_active_idx ON http_origin_hops(origin,host_id) WHERE state IN ('reserved','dispatched','indeterminate');
--> statement-breakpoint
CREATE TABLE http_origin_events (
 id bigserial PRIMARY KEY, hop_id uuid NOT NULL REFERENCES http_origin_hops(id),
 kind text NOT NULL CHECK(kind IN ('reserved','dispatched','indeterminate','released','cancelled')),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION http_origin_events_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'http_origin_events_append_only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER http_origin_events_no_change BEFORE UPDATE OR DELETE ON http_origin_events FOR EACH STATEMENT EXECUTE FUNCTION http_origin_events_reject_change();
ALTER TABLE http_origin_events ENABLE ALWAYS TRIGGER http_origin_events_no_change;
CREATE TRIGGER http_origin_events_no_truncate BEFORE TRUNCATE ON http_origin_events FOR EACH STATEMENT EXECUTE FUNCTION http_origin_events_reject_change();
ALTER TABLE http_origin_events ENABLE ALWAYS TRIGGER http_origin_events_no_truncate;
