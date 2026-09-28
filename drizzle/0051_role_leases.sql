CREATE TABLE "role_leases" (
	"role" varchar(30) PRIMARY KEY NOT NULL,
	"owner_instance_id" varchar(120),
	"owner_boot_id" varchar(36),
	"owner_kind" varchar(10),
	"owner_release" varchar(120),
	"epoch" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
