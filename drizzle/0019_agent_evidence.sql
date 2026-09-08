CREATE TABLE "agent_repository_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_id" integer NOT NULL,
	"observation_key" varchar(64) NOT NULL,
	"facts" jsonb NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_repository_scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"repository_key" varchar(200) NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"detector_version" varchar(40) NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"scope_hash" varchar(64) NOT NULL,
	"state" varchar(16) NOT NULL,
	"cursor" jsonb,
	"request_count" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"coverage" jsonb DEFAULT '{"limited":false}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"last_error_code" varchar(60),
	"next_attempt_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_discovery_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_key" varchar(200) NOT NULL,
	"signal_id" varchar(80) NOT NULL,
	"evidence_key" varchar(64) NOT NULL,
	"source_url" text NOT NULL,
	"commit_sha" varchar(64),
	"attribution" jsonb,
	"search_window_from" timestamp,
	"search_window_to" timestamp,
	"incomplete" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_repository_observations" ADD CONSTRAINT "agent_repository_observations_scan_id_agent_repository_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."agent_repository_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_observations_scan_key_idx" ON "agent_repository_observations" USING btree ("scan_id","observation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_scans_identity_idx" ON "agent_repository_scans" USING btree ("github_repository_id","commit_sha","detector_version","scope_hash");--> statement-breakpoint
CREATE INDEX "agent_scans_due_idx" ON "agent_repository_scans" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_scans_repository_idx" ON "agent_repository_scans" USING btree ("repository_key");--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_discovery_repository_key_idx" ON "crawl_discovery_evidence" USING btree ("repository_key","evidence_key");