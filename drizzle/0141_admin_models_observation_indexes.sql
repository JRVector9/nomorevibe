-- Read-only admin observation uses a bounded completion range plus the existing active/waiting indexes.
CREATE INDEX model_capacity_requests_settled_at_idx ON model_capacity_requests (settled_at) WHERE state = 'settled';
--> statement-breakpoint
CREATE INDEX model_capacity_requests_withdrawn_at_idx ON model_capacity_requests (updated_at) WHERE state = 'withdrawn';
