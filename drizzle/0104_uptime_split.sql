-- U1a: uptime 제품 단위 분담(split-v1)의 표. 새 표 4개와 백필만 더한다. 제어 행은 legacy 로 시작해 이 migration 만으로는 동작이 바뀌지 않는다.
-- 기존 표 변경은 하나다: uptime_control 에 split 상호 배제 트리거(PR09 raw-only·gate 는 split claims 동안 켤 수 없다). 기존 열·CHECK·권한은 그대로다.
-- 시각: product_health.checked_at·products.updated_at 은 시간대 없는 UTC 다. 새 열은 timestamptz 이고 비교할 때 AT TIME ZONE 'UTC' 로 맞춘다.
CREATE TABLE uptime_split_control (
 id integer PRIMARY KEY DEFAULT 1 CONSTRAINT uptime_split_control_id CHECK (id = 1),
 mode varchar(10) NOT NULL DEFAULT 'legacy' CONSTRAINT uptime_split_control_mode CHECK (mode IN ('legacy','claims')),
 epoch bigint NOT NULL DEFAULT 1 CONSTRAINT uptime_split_control_epoch CHECK (epoch BETWEEN 1 AND 9007199254740991),
 policy jsonb, policy_hash varchar(64),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uptime_split_control_policy CHECK ((policy IS NULL) = (policy_hash IS NULL)
   AND (policy IS NULL OR (jsonb_typeof(policy) = 'object' AND policy_hash ~ '^[a-f0-9]{64}$'))
   AND (mode = 'legacy' OR policy IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO uptime_split_control (id) VALUES (1);
--> statement-breakpoint
-- 제품당 1행. idle → claimed(SKIP LOCKED claim) → submitted(token·epoch CAS 제출) → idle(home 적용기). epoch 는 claim 회차다.
CREATE TABLE uptime_claims (
 product_id integer PRIMARY KEY,
 state varchar(10) NOT NULL DEFAULT 'idle',
 due_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 epoch bigint NOT NULL DEFAULT 0,
 control_epoch bigint, token uuid, owner_instance_id varchar(48), owner_boot_id uuid,
 host varchar(24), host_class varchar(8),
 lease_until timestamptz(3), claimed_at timestamptz(3),
 claim_slug varchar(80), claim_url text, origin text, claim_slot timestamptz(3),
 confirm_class varchar(8), confirm_reason varchar(64), confirm_requested_at timestamptz(3),
 affinity_home_until timestamptz(3), conflict_count integer NOT NULL DEFAULT 0,
 result_started_at timestamptz(3), result_observed_at timestamptz(3), result_kind varchar(12),
 result_status integer, result_latency_ms integer, submitted_at timestamptz(3),
 last_applied_at timestamptz(3), last_applied_host varchar(24), last_outcome varchar(32),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uptime_claims_state CHECK (
   (state = 'idle' AND token IS NULL AND lease_until IS NULL)
   OR (state = 'claimed' AND token IS NOT NULL AND epoch >= 1 AND control_epoch IS NOT NULL AND owner_instance_id IS NOT NULL
     AND owner_boot_id IS NOT NULL AND host IS NOT NULL AND lease_until IS NOT NULL AND claimed_at IS NOT NULL AND claim_slug IS NOT NULL
     AND claim_url IS NOT NULL AND origin IS NOT NULL AND claim_slot IS NOT NULL AND result_started_at IS NULL AND result_observed_at IS NULL
     AND result_kind IS NULL AND result_status IS NULL AND result_latency_ms IS NULL AND submitted_at IS NULL)
   OR (state = 'submitted' AND token IS NOT NULL AND epoch >= 1 AND control_epoch IS NOT NULL AND owner_instance_id IS NOT NULL
     AND host IS NOT NULL AND lease_until IS NULL AND claimed_at IS NOT NULL AND claim_slug IS NOT NULL AND claim_url IS NOT NULL
     AND result_started_at IS NOT NULL AND result_observed_at IS NOT NULL AND result_kind IS NOT NULL AND submitted_at IS NOT NULL)),
 CONSTRAINT uptime_claims_epochs CHECK (epoch BETWEEN 0 AND 9007199254740991
   AND (control_epoch IS NULL OR control_epoch BETWEEN 1 AND 9007199254740991) AND conflict_count >= 0),
 -- Oracle 은 언제나 probe 다. probe 실패는 카운터를 올리지 않으므로 Oracle 이 home 으로 기록될 길을 표에서 막는다
 CONSTRAINT uptime_claims_host CHECK ((host IS NULL) = (host_class IS NULL)
   AND (host IS NULL OR (host IN ('m3','mini','oracle-osaka-smoke') AND host_class IN ('home','probe')
     AND (host = 'oracle-osaka-smoke') = (host_class = 'probe')))
   AND (last_applied_host IS NULL OR last_applied_host IN ('m3','mini','oracle-osaka-smoke'))),
 CONSTRAINT uptime_claims_confirm CHECK ((confirm_class IS NULL OR confirm_class = 'home')
   AND (confirm_class IS NULL) = (confirm_requested_at IS NULL) AND (confirm_reason IS NULL OR confirm_class IS NOT NULL)),
 CONSTRAINT uptime_claims_result CHECK ((result_kind IS NULL) = (result_status IS NULL)
   AND (result_kind IS NULL OR (result_kind = 'http' AND result_status BETWEEN 100 AND 599)
     OR (result_kind IN ('timeout','dns','network','unknown') AND result_status = 0))
   AND (result_latency_ms IS NULL OR result_latency_ms >= 0)
   AND (result_observed_at IS NULL OR result_started_at IS NULL OR result_observed_at >= result_started_at)),
 CONSTRAINT uptime_claims_slot CHECK (claim_slot IS NULL OR extract(epoch FROM claim_slot) % 21600 = 0)
);
--> statement-breakpoint
-- host 차단기 재료: 적용기가 묶음마다 host 별로 분 단위 칸에 더한다(append-only 아님, 오래된 칸은 적용기가 지운다)
CREATE TABLE uptime_host_windows (
 host varchar(24) NOT NULL, bucket timestamptz(0) NOT NULL,
 checks integer NOT NULL, failures integer NOT NULL, transport integer NOT NULL,
 PRIMARY KEY (host, bucket),
 CONSTRAINT uptime_host_windows_counts CHECK (host IN ('m3','mini','oracle-osaka-smoke') AND checks >= 0
   AND failures BETWEEN 0 AND checks AND transport BETWEEN 0 AND failures AND extract(second FROM bucket) = 0)
);
--> statement-breakpoint
-- host 차단기 상태. 행이 없으면 closed 다. probe_checks·probe_failures 는 probing 동안 받은 확인 수다
CREATE TABLE uptime_host_breakers (
 host varchar(24) PRIMARY KEY,
 state varchar(10) NOT NULL, opened_at timestamptz(3), probe_after timestamptz(3),
 cool_down_ms integer NOT NULL DEFAULT 600000, reason varchar(64), ratio numeric(6,4),
 probe_checks integer NOT NULL DEFAULT 0, probe_failures integer NOT NULL DEFAULT 0,
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uptime_host_breakers_shape CHECK (host IN ('m3','mini','oracle-osaka-smoke')
   AND ((state = 'closed' AND probe_after IS NULL AND probe_checks = 0 AND probe_failures = 0)
     OR (state IN ('open','probing') AND opened_at IS NOT NULL AND probe_after IS NOT NULL))
   AND (state = 'probing' OR (probe_checks = 0 AND probe_failures = 0))
   AND cool_down_ms BETWEEN 60000 AND 86400000 AND (ratio IS NULL OR ratio BETWEEN 0 AND 1)
   AND probe_checks >= 0 AND probe_failures BETWEEN 0 AND probe_checks)
);
--> statement-breakpoint
-- split claims 와 PR09 관측·gate 는 함께 켤 수 없다. 두 행을 FOR SHARE 로 잠그고 보므로 동시에 켜려는 두 트랜잭션은
-- 한쪽이 기다리거나 교착 검출로 끝난다(둘 다 commit 되지 않는다). 복제 적용(session_replication_role=replica)에서는 원본이 이미 검사했다.
CREATE FUNCTION uptime_split_exclusive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other record;
BEGIN
  IF TG_TABLE_NAME = 'uptime_split_control' THEN
    IF NEW.mode = 'claims' THEN
      SELECT observations_enabled, gate_enabled INTO other FROM uptime_control WHERE id = 1 FOR SHARE;
      IF FOUND AND (other.observations_enabled OR other.gate_enabled) THEN
        RAISE EXCEPTION 'uptime_split_requires_uptime_control_disabled' USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSIF NEW.observations_enabled OR NEW.gate_enabled THEN
    SELECT mode INTO other FROM uptime_split_control WHERE id = 1 FOR SHARE;
    IF FOUND AND other.mode = 'claims' THEN
      RAISE EXCEPTION 'uptime_control_requires_split_legacy' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER uptime_split_control_exclusive BEFORE INSERT OR UPDATE ON uptime_split_control
 FOR EACH ROW EXECUTE FUNCTION uptime_split_exclusive_guard();
--> statement-breakpoint
CREATE TRIGGER uptime_control_split_exclusive BEFORE INSERT OR UPDATE ON uptime_control
 FOR EACH ROW EXECUTE FUNCTION uptime_split_exclusive_guard();
--> statement-breakpoint
-- 백필: 공개 website 제품(운영 약 4만 1천)마다 1행. due 는 마지막 확인 + 6시간, 확인한 적 없으면 지금이다.
-- products·product_health 는 읽기만 한다(ACCESS SHARE). 외래 키는 아래에서 마지막에 건다 — 행마다 FK 확인이 products 행을 잠그지 않게.
INSERT INTO uptime_claims (product_id, due_at)
SELECT p.id, coalesce((h.checked_at AT TIME ZONE 'UTC') + interval '6 hours', clock_timestamp())
FROM products p LEFT JOIN product_health h ON h.slug = p.slug
WHERE p.status IN ('verified','seeded') AND p.access_mode = 'website';
--> statement-breakpoint
CREATE INDEX uptime_claims_due_idx ON uptime_claims (due_at, product_id) WHERE state <> 'submitted';
--> statement-breakpoint
CREATE INDEX uptime_claims_origin_live_idx ON uptime_claims (origin) WHERE state = 'claimed';
--> statement-breakpoint
CREATE INDEX uptime_claims_submitted_idx ON uptime_claims (submitted_at, product_id) WHERE state = 'submitted';
--> statement-breakpoint
-- 여기부터 commit 까지 products 쓰기를 막는다(SHARE ROW EXCLUSIVE, 읽기·FOR UPDATE 는 통과). 백필 뒤 지워진 제품의 행을 빼고
-- 외래 키를 건다. 검증은 색인 anti-join 한 번이다. lock 대기는 scripts/migrate.mjs 의 lock_timeout(10s)이 끊는다.
LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DELETE FROM uptime_claims c WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = c.product_id);
--> statement-breakpoint
ALTER TABLE uptime_claims ADD CONSTRAINT uptime_claims_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
