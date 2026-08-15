CREATE TABLE "og_images" (
	"slug" varchar(80) PRIMARY KEY NOT NULL,
	"content_type" varchar(40) NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
