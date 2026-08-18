CREATE TABLE "product_health" (
	"slug" varchar(80) PRIMARY KEY NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"status" integer NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"down_since" timestamp
);
