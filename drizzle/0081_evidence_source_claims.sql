CREATE TABLE evidence_source_control (
 id integer PRIMARY KEY DEFAULT 1 CONSTRAINT evidence_source_control_id CHECK(id=1),
 enabled boolean NOT NULL DEFAULT false,
 epoch bigint NOT NULL DEFAULT 1 CONSTRAINT evidence_source_control_epoch CHECK(epoch BETWEEN 1 AND 9007199254740991),
 cursor integer NOT NULL DEFAULT 0 CONSTRAINT evidence_source_control_cursor CHECK(cursor BETWEEN 0 AND 3)
);
--> statement-breakpoint
INSERT INTO evidence_source_control(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE evidence_source_claims (
 product_id integer PRIMARY KEY, binding jsonb NOT NULL, binding_hash varchar(64) NOT NULL,
 control_epoch bigint NOT NULL, epoch bigint NOT NULL,
 instance_id varchar(120), boot_id varchar(120), token uuid, job jsonb,
 lease_until timestamp(3) with time zone, lane varchar(10) NOT NULL,
 next_attempt_at timestamp(3) with time zone NOT NULL DEFAULT clock_timestamp(),
 last_outcome varchar(40), updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT evidence_source_claims_owner CHECK ((token IS NULL AND instance_id IS NULL AND boot_id IS NULL AND lease_until IS NULL AND job IS NULL) OR (token IS NOT NULL AND instance_id IS NOT NULL AND boot_id IS NOT NULL AND lease_until IS NOT NULL)),
 CONSTRAINT evidence_source_claims_epochs CHECK (product_id>0 AND epoch BETWEEN 1 AND 9007199254740991 AND control_epoch BETWEEN 1 AND 9007199254740991),
 CONSTRAINT evidence_source_claims_hash CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT evidence_source_claims_lane CHECK (lane IN ('admin','normal','catchup'))
);
--> statement-breakpoint
CREATE INDEX evidence_source_claims_due ON evidence_source_claims(next_attempt_at,product_id);
