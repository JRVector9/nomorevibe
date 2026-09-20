CREATE TABLE "search_queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"query" varchar(200) NOT NULL,
	"normalized" varchar(200) NOT NULL,
	"keywords" varchar(200),
	"results" integer NOT NULL,
	"filtered" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"searched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "search_queries_recent_idx" ON "search_queries" USING btree ("searched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "search_queries_zero_idx" ON "search_queries" USING btree ("normalized") WHERE "search_queries"."results" = 0;