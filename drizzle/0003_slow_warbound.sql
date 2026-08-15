CREATE TABLE "jobs" (
	"name" varchar(60) PRIMARY KEY NOT NULL,
	"cursor" jsonb,
	"locked_at" timestamp,
	"last_run_at" timestamp,
	"last_success_at" timestamp,
	"last_error" text,
	"runs" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
