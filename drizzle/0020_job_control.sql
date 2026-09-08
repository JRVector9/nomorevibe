ALTER TABLE "jobs" ADD COLUMN "requested_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "processed_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_scheduled_at" timestamp;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "not_before" timestamp;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_token" varchar(36);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "worker_seen_at" timestamp;