ALTER TABLE "takedown_requests" ADD COLUMN "requester_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "takedown_requests" ADD COLUMN "request_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "takedown_requests" ADD COLUMN "previous_outcome" varchar(20);--> statement-breakpoint
ALTER TABLE "takedown_requests" ADD COLUMN "dismiss_reason" varchar(24);--> statement-breakpoint
ALTER TABLE "takedown_requests" ADD COLUMN "note" text;
