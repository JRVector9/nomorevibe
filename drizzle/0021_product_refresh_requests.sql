CREATE TABLE "product_refresh_requests" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"requested_version" integer DEFAULT 1 NOT NULL,
	"completed_version" integer DEFAULT 0 NOT NULL,
	"active_version" integer,
	"force" boolean DEFAULT false NOT NULL,
	"active_force" boolean DEFAULT false NOT NULL,
	"progress" jsonb DEFAULT '{"completedKeys":[],"retryAfterByKey":{}}'::jsonb NOT NULL,
	"actor" varchar(120) NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" varchar(200),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "product_refresh_requests_due_idx" ON "product_refresh_requests" USING btree ("next_attempt_at","product_id") WHERE "product_refresh_requests"."requested_version" > "product_refresh_requests"."completed_version";--> statement-breakpoint
CREATE INDEX "product_refresh_requests_slug_idx" ON "product_refresh_requests" USING btree ("slug");