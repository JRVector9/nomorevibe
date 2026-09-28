ALTER TABLE "role_leases" ADD COLUMN "primary_boots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "role_leases" ADD COLUMN "quarantine_until" timestamp;