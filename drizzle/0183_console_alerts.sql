-- 0183: 휴대폰 알림(2026-11-12 운영 콘솔 개편 조각 4b).
-- 홈 할 일 중 알림 묶음(멈춤 · 평소와 다름)의 「한 번 생김」 하나가 한 줄이다. maintenance 잡 console-alerts 가 열고·이어 쓰고·닫는다.
-- 닫히지 않았고 내보낸(released_at) 줄을 감시(monitor)가 읽어 기존 Telegram 통로(복구 게이트웨이 → Oracle watchdog)로 넘긴다 — Oracle 이 줄 id 마다 한 번 보낸다.
-- 열린 줄은 할 일 열쇠마다 하나(부분 유일 색인) — 같은 할 일이 이어지는 동안 다시 보내지 않고, 닫힌 뒤 다시 생기면 새 줄이다.
-- 알림 설정(켜기·조용한 시간)은 표 없이 작업 로그(operations_audit, console-alert-settings)의 마지막 줄이다.
-- 새 표만 만든다. 옛 코드는 이 표를 읽지 않는다.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE console_alerts (
  id bigserial PRIMARY KEY,
  task_id varchar(160) NOT NULL,
  rule varchar(40) NOT NULL,
  group_key varchar(8) NOT NULL,
  title varchar(200) NOT NULL,
  fact varchar(400) NOT NULL,
  href varchar(400) NOT NULL,
  opened_at timestamp(3) with time zone NOT NULL DEFAULT clock_timestamp(),
  seen_at timestamp(3) with time zone NOT NULL DEFAULT clock_timestamp(),
  missing_since timestamp(3) with time zone,
  released_at timestamp(3) with time zone,
  closed_at timestamp(3) with time zone,
  close_reason varchar(16),
  CONSTRAINT console_alerts_group_check CHECK (group_key IN ('stop','odd','pile','tidy')),
  CONSTRAINT console_alerts_close_check CHECK ((closed_at IS NULL) = (close_reason IS NULL) AND (close_reason IS NULL OR close_reason IN ('resolved','kept','disabled'))),
  CONSTRAINT console_alerts_text_check CHECK (title !~ '[[:cntrl:]]' AND fact !~ '[[:cntrl:]]' AND href !~ '[[:cntrl:]]' AND char_length(title) >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX console_alerts_open_task_idx ON console_alerts (task_id) WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE INDEX console_alerts_released_idx ON console_alerts (id) WHERE closed_at IS NULL AND released_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX console_alerts_opened_idx ON console_alerts (opened_at DESC);
--> statement-breakpoint
COMMENT ON TABLE console_alerts IS '0183: 휴대폰 알림 — 홈 할 일(멈춤·평소와 다름)의 한 번 생김마다 한 줄. released 이고 열린 줄을 monitor 가 Oracle Telegram 통로로 넘긴다(줄 id 마다 한 번)';
