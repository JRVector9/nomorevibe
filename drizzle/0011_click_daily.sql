CREATE TABLE "product_click_daily" (
	"slug" varchar(80) NOT NULL,
	"day" date NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_click_daily_slug_day_pk" PRIMARY KEY("slug","day")
);
