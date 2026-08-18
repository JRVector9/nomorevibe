CREATE TABLE "ranking_entries" (
	"season_id" integer NOT NULL,
	"slug" varchar(80) NOT NULL,
	"valid_clicks" integer DEFAULT 0 NOT NULL,
	"cooldown_factor_basis_points" integer DEFAULT 10000 NOT NULL,
	"score_units" bigint DEFAULT 0 NOT NULL,
	"rank" integer NOT NULL,
	"change_percent" numeric(12, 1),
	"recent_clicks" integer DEFAULT 0 NOT NULL,
	"previous_clicks" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"finalized_at" timestamp,
	CONSTRAINT "ranking_entries_season_id_slug_pk" PRIMARY KEY("season_id","slug")
);
--> statement-breakpoint
CREATE TABLE "ranking_policy_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"values" jsonb NOT NULL,
	"state" varchar(20) NOT NULL,
	"created_by" varchar(120) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"applied_at" timestamp,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ranking_seasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(48) NOT NULL,
	"cadence" varchar(10) NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"state" varchar(10) NOT NULL,
	"policy_revision_id" integer NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"effective_launch_window_days" integer NOT NULL,
	"is_transition" boolean DEFAULT false NOT NULL,
	"refreshed_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	CONSTRAINT "ranking_seasons_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "ranking_entries" ADD CONSTRAINT "ranking_entries_season_id_ranking_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."ranking_seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_seasons" ADD CONSTRAINT "ranking_seasons_policy_revision_id_ranking_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."ranking_policy_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ranking_entries_rank_idx" ON "ranking_entries" USING btree ("season_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_policy_one_scheduled_idx" ON "ranking_policy_revisions" USING btree ("state") WHERE "ranking_policy_revisions"."state" = 'scheduled';--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_seasons_one_active_idx" ON "ranking_seasons" USING btree ("state") WHERE "ranking_seasons"."state" = 'active';--> statement-breakpoint
CREATE INDEX "ranking_seasons_dates_idx" ON "ranking_seasons" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "click_events_time_slug_idx" ON "click_events" USING btree ("occurred_at","slug");

DELETE FROM "product_click_daily"
WHERE "day" >= ((now() AT TIME ZONE 'Asia/Seoul')::date - 35);

INSERT INTO "product_click_daily" ("slug", "day", "clicks")
SELECT
  "slug",
  timezone('Asia/Seoul', "occurred_at" AT TIME ZONE 'UTC')::date,
  count(*)::int
FROM "click_events"
WHERE "occurred_at" >= now() - interval '35 days'
GROUP BY 1, 2
ON CONFLICT ("slug", "day") DO UPDATE SET "clicks" = excluded."clicks";
