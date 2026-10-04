import type { ModelHealth } from "@/lib/operations/dashboard";
import { CodexReconnectButton } from "./CodexReconnect";

const n = (value: number) => value.toLocaleString("ko-KR");

export type ConnectionProbe = { provider: "claude" | "codex" | "grok"; result: string | null; checkedAt: string | null };
const PROBE_LABEL = { claude: "Claude", codex: "Codex", grok: "Grok" } as const;

function tone(row: ModelHealth): { tone: "ok" | "warn" | "bad"; text: string } {
  if (row.calls1h === 0) return { tone: "ok", text: "호출 없음" };
  const failRate = row.failed1h / row.calls1h;
  if (row.key === "second" && row.agreement1h !== null && row.agreement1h < 0.7) return { tone: "warn", text: `일치 ${Math.round(row.agreement1h * 100)}%` };
  if (failRate >= 0.2) return { tone: "bad", text: `실패 ${Math.round(failRate * 100)}%` };
  if (failRate >= 0.1) return { tone: "warn", text: `실패 ${Math.round(failRate * 100)}%` };
  return { tone: "ok", text: "정상" };
}

/**
 * 모델 연결 — 최근 1시간 호출·실패·지연과, 연결 서비스가 잰 Claude·Codex 응답.
 *
 * 실패율이 10%를 넘거나 2차 일치율이 70% 아래면 카드 색이 바뀐다. 2026-10-02 실측: 2차 투표자 일치 53% 는
 * 숫자로만 있었고 화면엔 "대기 N건"만 있었다.
 */
export function ModelCards({ rows, probes }: { rows: ModelHealth[]; probes: ConnectionProbe[] }) {
  return (
    <section className="dash-card dash-4" aria-label="모델 연결">
      <div className="dash-card-h"><h2>모델 연결 · 최근 1시간</h2><small>호출 · 실패 · 평균</small></div>
      <div className="dash-models">
        {rows.map((row) => {
          const state = tone(row);
          return (
            <div key={row.key} className="dash-model">
              <span className="role">{row.label}</span>
              <span className="dash-pill" data-tone={state.tone}>{state.text}</span>
              <span className="name" title={row.model ?? undefined}>{row.model ?? "설정 없음"}</span>
              <span className="stat"><b>{n(row.calls1h)}</b> · 실패 <b>{n(row.failed1h)}</b>{row.avgSeconds !== null && <> · <b>{row.avgSeconds.toFixed(1)}</b>초{(row.key === "second" || row.key === "fallback") && " (대기 포함)"}</>}
                {row.key !== "second" && row.agreement1h !== null && <> · 일치 <b>{Math.round(row.agreement1h * 100)}%</b></>}</span>
            </div>
          );
        })}
      </div>
      {probes.length > 0 && (
        <div className="dash-chips" style={{ marginTop: 10 }}>
          {probes.map((probe) => (
            probe.provider === "codex" && (probe.result === "access_denied" || probe.result === "auth") ?
            <CodexReconnectButton key={probe.provider} result={probe.result} /> :
            <span key={probe.provider} className="dash-pill" data-tone={probe.result === "success" ? "ok" : probe.result ? "bad" : undefined}>
              <span className="dash-dot" data-tone={probe.result === "success" ? "ok" : probe.result ? "bad" : undefined} aria-hidden />
              {PROBE_LABEL[probe.provider]} 연결 {probe.result === "success" ? "확인" : probe.result ?? "미확인"}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
