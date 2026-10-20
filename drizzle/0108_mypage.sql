-- 마이페이지(MY1~MY8) 표 — 마이페이지 시안 4절·로그인 설계 8.1절·써봤어요 피드백 설계 5절(2026-10-18).
-- 기존 표에는 비워 둘 수 있는 열만 더하고, 새 표는 모두 계정·제품이 지워지면 함께 지워진다(작성자 열은 탈퇴 익명화로 남긴다).
-- 계정 표의 ALTER(ACCESS EXCLUSIVE)는 맨 끝에 둔다 — 앞에서 잡으면 products FK·색인이 잠금을 기다리는 동안
-- 로그인한 모든 요청(public_sessions 읽기)이 함께 멈춘다.

-- MY2 (L4): 계정 저장 목록. merge = 첫 로그인 때 이 브라우저 목록에서 옮긴 것
CREATE TABLE "user_saved_products" (
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "source" varchar(8) DEFAULT 'web' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "product_id"),
  CONSTRAINT "user_saved_products_source_check" CHECK ("source" in ('web', 'merge'))
);
--> statement-breakpoint
CREATE INDEX "user_saved_products_user_created_idx" ON "user_saved_products" ("user_id", "created_at" DESC);
--> statement-breakpoint

-- MY3 (피드백 PR2): 써봤어요 — 한 방문자(또는 계정)의 한 제품에 대한 현재 평가
CREATE TABLE "product_reactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "visitor_hash" varchar(64),
  "user_id" integer REFERENCES "public_users"("id") ON DELETE SET NULL,
  "verdict" varchar(8) NOT NULL,
  "tags" text[] DEFAULT '{}' NOT NULL,
  "tried_verified" boolean DEFAULT false NOT NULL,
  "comment" varchar(140),
  "comment_state" varchar(16),
  "comment_reason" varchar(40),
  "ranking_excluded" boolean DEFAULT false NOT NULL,
  "source" varchar(16) NOT NULL,
  "device" varchar(8),
  "locale" varchar(8) NOT NULL,
  "changes_today" smallint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_reactions_verdict_check" CHECK ("verdict" in ('good', 'meh', 'bad')),
  CONSTRAINT "product_reactions_tags_check" CHECK (cardinality("tags") <= 4),
  CONSTRAINT "product_reactions_comment_state_check" CHECK ("comment_state" is null or "comment_state" in ('accepted', 'held', 'rejected')),
  CONSTRAINT "product_reactions_comment_check" CHECK (("comment" is null) = ("comment_state" is null)),
  CONSTRAINT "product_reactions_source_check" CHECK ("source" in ('panel', 'return', 'sheet', 'me')),
  CONSTRAINT "product_reactions_device_check" CHECK ("device" is null or "device" in ('phone', 'desktop')),
  CONSTRAINT "product_reactions_owner_check" CHECK ("visitor_hash" is not null or "user_id" is not null),
  CONSTRAINT "product_reactions_visitor_hash_check" CHECK ("visitor_hash" is null or "visitor_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_reactions_visitor_idx" ON "product_reactions" ("product_id", "visitor_hash") WHERE "visitor_hash" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "product_reactions_user_idx" ON "product_reactions" ("product_id", "user_id") WHERE "user_id" is not null;
--> statement-breakpoint
CREATE INDEX "product_reactions_product_idx" ON "product_reactions" ("product_id", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX "product_reactions_user_updated_idx" ON "product_reactions" ("user_id", "updated_at" DESC) WHERE "user_id" is not null;
--> statement-breakpoint
CREATE INDEX "product_reactions_held_idx" ON "product_reactions" ("created_at") WHERE "comment_state" = 'held';
--> statement-breakpoint

-- MY4 (L7): 팔로 — 대상은 제품 id · GitHub 주인 숫자 id · 분야 slug
CREATE TABLE "user_follows" (
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "target_type" varchar(12) NOT NULL,
  "target_key" varchar(120) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "target_type", "target_key"),
  CONSTRAINT "user_follows_target_type_check" CHECK ("target_type" in ('product', 'maker', 'category')),
  CONSTRAINT "user_follows_target_key_check" CHECK (char_length("target_key") between 1 and 120)
);
--> statement-breakpoint
CREATE INDEX "user_follows_target_idx" ON "user_follows" ("target_type", "target_key");
--> statement-breakpoint
CREATE INDEX "user_follows_user_created_idx" ON "user_follows" ("user_id", "created_at" DESC);
--> statement-breakpoint

-- MY4 (L7): 사이트 안 알림함. 같은 일에는 dedupe_key 로 한 줄만, 90일 보관(maintenance 정리)
CREATE TABLE "notifications" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "kind" varchar(24) NOT NULL,
  "product_id" integer REFERENCES "products"("id") ON DELETE CASCADE,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dedupe_key" varchar(120) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "read_at" timestamp with time zone,
  CONSTRAINT "notifications_kind_check" CHECK ("kind" in ('maker_reply', 'followed_release', 'followed_delisted', 'maker_new_project', 'category_new', 'comment_reviewed', 'new_listing_mine', 'inbox_new')),
  CONSTRAINT "notifications_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_idx" ON "notifications" ("user_id", "dedupe_key");
--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" ("user_id", "created_at" DESC) WHERE "read_at" is null;
--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" ("created_at");
--> statement-breakpoint

-- MY7 (L8): 알림 설정 — 사이트 안 알림함은 늘 켜져 있고, 여기서는 메일로 받을지(즉시·주간·끔)만 정한다
CREATE TABLE "notification_settings" (
  "user_id" integer PRIMARY KEY NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "email_identity_id" integer REFERENCES "public_identities"("id") ON DELETE SET NULL,
  "maker_reply" varchar(8) DEFAULT 'instant' NOT NULL,
  "followed_project" varchar(8) DEFAULT 'weekly' NOT NULL,
  "followed_maker" varchar(8) DEFAULT 'off' NOT NULL,
  "followed_category" varchar(8) DEFAULT 'weekly' NOT NULL,
  "new_listing_mine" varchar(8) DEFAULT 'instant' NOT NULL,
  "digest_weekday" smallint DEFAULT 1 NOT NULL,
  "digest_hour" smallint DEFAULT 9 NOT NULL,
  "news_opt_in_at" timestamp with time zone,
  "locale" varchar(8) DEFAULT 'ko' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_settings_mode_check" CHECK (
    "maker_reply" in ('instant', 'weekly', 'off') and "followed_project" in ('instant', 'weekly', 'off')
    and "followed_maker" in ('instant', 'weekly', 'off') and "followed_category" in ('weekly', 'off')
    and "new_listing_mine" in ('instant', 'off')),
  CONSTRAINT "notification_settings_digest_check" CHECK ("digest_weekday" between 0 and 6 and "digest_hour" between 0 and 23),
  CONSTRAINT "notification_settings_locale_check" CHECK ("locale" in ('ko', 'en', 'zh-Hans', 'zh-Hant'))
);
--> statement-breakpoint

-- MY7 (L8): 메일 발송함 — github_issue_outbox 와 같은 방식. 발신 설정(LOGIN_EMAIL_*)이 없으면 쌓지 않는다
CREATE TABLE "email_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" integer REFERENCES "public_users"("id") ON DELETE CASCADE,
  "kind" varchar(24) NOT NULL,
  "dedupe_key" varchar(120) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "state" varchar(12) DEFAULT 'pending' NOT NULL,
  "attempts" smallint DEFAULT 0 NOT NULL,
  "last_error" varchar(200),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  CONSTRAINT "email_outbox_state_check" CHECK ("state" in ('pending', 'accepted', 'rejected', 'unknown', 'skipped')),
  CONSTRAINT "email_outbox_attempts_check" CHECK ("attempts" between 0 and 10),
  CONSTRAINT "email_outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_dedupe_idx" ON "email_outbox" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "email_outbox_pending_idx" ON "email_outbox" ("next_attempt_at") WHERE "state" = 'pending';
--> statement-breakpoint

-- MY5 (L5 = 피드백 PR8): 운영자 확인 — GitHub 로그인 숫자 id 가 저장소 주인 숫자 id 와 같으면 owner
CREATE TABLE "product_maker_members" (
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "public_users"("id") ON DELETE CASCADE,
  "role" varchar(8) NOT NULL,
  "github_user_id" bigint,
  "method" varchar(20) NOT NULL,
  "verified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "recheck_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_reason" varchar(40),
  PRIMARY KEY ("product_id", "user_id"),
  CONSTRAINT "product_maker_members_role_check" CHECK ("role" in ('owner', 'editor')),
  CONSTRAINT "product_maker_members_method_check" CHECK ("method" in ('github_repo_owner', 'github_repo_admin', 'repo_file', 'edit_token', 'admin'))
);
--> statement-breakpoint
CREATE INDEX "product_maker_members_user_idx" ON "product_maker_members" ("user_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "product_maker_members_product_idx" ON "product_maker_members" ("product_id") WHERE "revoked_at" is null;
--> statement-breakpoint

-- MY6 (피드백 PR9): 메이커 답장 — 대상은 써봤어요 한 줄 또는 로그인 댓글
CREATE TABLE "maker_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" integer NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "target_type" varchar(12) NOT NULL,
  "target_id" uuid NOT NULL,
  "author_user_id" integer NOT NULL REFERENCES "public_users"("id"),
  "body" varchar(1000) NOT NULL,
  "review_state" varchar(16) DEFAULT 'accepted' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maker_replies_target_type_check" CHECK ("target_type" in ('reaction', 'feedback')),
  CONSTRAINT "maker_replies_review_check" CHECK ("review_state" in ('accepted', 'held', 'rejected')),
  CONSTRAINT "maker_replies_body_check" CHECK (char_length(btrim("body")) between 1 and 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "maker_replies_target_idx" ON "maker_replies" ("target_type", "target_id");
--> statement-breakpoint
CREATE INDEX "maker_replies_product_idx" ON "maker_replies" ("product_id", "created_at" DESC);
--> statement-breakpoint

-- MY4·MY5: 메이커 팔로·내 저장소 찾기·주소로 확인이 쓰는 저장소 주인 열쇠 — 질의(lib/me/follows.ts·maker.ts·maker-claims.ts)와 같은 식이어야 탄다
CREATE INDEX "products_listed_owner_idx" ON "products" ((substring(lower("repo_url") from '^https?://(?:www\.)?github\.com/([a-z0-9-]+)/[^/]+/?$')));
--> statement-breakpoint
CREATE INDEX "products_renamed_owner_idx" ON "products" ((nullif(lower(split_part("repo_renamed_to", '/', 1)), ''))) WHERE "repo_renamed_to" is not null;
--> statement-breakpoint
CREATE INDEX "products_renamed_to_idx" ON "products" ((lower("repo_renamed_to"))) WHERE "repo_renamed_to" is not null;
--> statement-breakpoint

-- MY1 (L3): 계정 화면 — 닉네임 바꾼 때(30일에 한 번), 탈퇴 표시(댓글 작성자 FK 때문에 행은 남긴다), 로그인 기기 목록
ALTER TABLE "public_users"
  ADD COLUMN "display_name_changed_at" timestamp with time zone,
  ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "public_identities"
  ADD COLUMN "provider_login" varchar(100),
  ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  ADD COLUMN "last_used_at" timestamp with time zone;
--> statement-breakpoint
-- 이미 있는 연결은 처음 확인한 때가 곧 연결한 때다(새 열의 기본값 now() 는 이 마이그레이션 시각)
UPDATE "public_identities" SET "created_at" = "verified_at";
--> statement-breakpoint
ALTER TABLE "public_sessions"
  ADD COLUMN "provider" varchar(32),
  ADD COLUMN "device_label" varchar(40),
  ADD COLUMN "last_seen_at" timestamp with time zone;
