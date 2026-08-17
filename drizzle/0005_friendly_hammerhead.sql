CREATE TABLE "crawl_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo" varchar(200) NOT NULL,
	"product_url" text,
	"state" varchar(20) DEFAULT 'new' NOT NULL,
	"reason" varchar(40),
	"decided_by" varchar(10),
	"signals" jsonb,
	"published_slug" varchar(80),
	"judged_at" timestamp,
	"decided_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawl_candidates_repo_unique" UNIQUE("repo")
);
--> statement-breakpoint
CREATE TABLE "crawl_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo" varchar(200) NOT NULL,
	"repo_meta" jsonb NOT NULL,
	"product_url" text,
	"page_status" integer,
	"page_meta" jsonb,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawl_documents_repo_unique" UNIQUE("repo")
);
--> statement-breakpoint
CREATE TABLE "crawl_frontier" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo" varchar(200) NOT NULL,
	"signal" varchar(40) NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crawl_frontier_repo_unique" UNIQUE("repo")
);
--> statement-breakpoint
CREATE INDEX "crawl_candidates_state_idx" ON "crawl_candidates" USING btree ("state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crawl_frontier_dequeue_idx" ON "crawl_frontier" USING btree ("state","next_attempt_at","priority" DESC NULLS LAST);