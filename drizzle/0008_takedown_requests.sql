CREATE TABLE "takedown_requests" (
	"slug" varchar(80) PRIMARY KEY NOT NULL,
	"reason" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"handled_at" timestamp,
	"handled_by" varchar(120),
	"outcome" varchar(20)
);
