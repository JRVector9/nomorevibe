import Link from "next/link";
import { STAGE_GROUPS, stageHref, type StageKey } from "./stages";

const n = (value: number) => value.toLocaleString("ko-KR");

/**
 * 심사 구간 — 후보가 파이프라인의 어디에 서 있는가(stages.ts). 여덟 칸을 한 줄에, 위에 단계 이름.
 *
 * 칸은 겹치지 않아 보류 칸들의 합이 보류 수다. 사람 몫(직접 판단)은 가장 오래 기다린 날수와 24시간 유입을 적어
 * 줄고 있는지 늘고 있는지가 숫자 하나로 보인다. 500건을 넘으면 주황.
 */
export function ReviewStageRail({ stage, counts, agreed, publication, humanAge }: {
  stage: StageKey | ""; counts: Record<StageKey, number>; agreed: { reject: number; approve: number };
  publication: { added: number; removed: number; net: number }; humanAge: { oldestDays: number | null; new24h: number } | null;
}) {
  const sub = (key: StageKey, hint: string) => key === "agreed" ? `거부 ${n(agreed.reject)} · 승인 ${n(agreed.approve)}`
    : key === "published" ? "괄호는 최근 24시간 순증감"
    : key === "human" && humanAge?.oldestDays !== null && humanAge ? `최장 ${humanAge.oldestDays}일 · 24h +${n(humanAge.new24h)}`
    : hint;
  return (
    <section className="dash-card" aria-labelledby="review-stages-title">
      <div className="dash-card-h"><h2 id="review-stages-title">심사 구간 · 후보가 지금 어디에 서 있나</h2><small>칸은 겹치지 않는다 — 보류 칸의 합이 보류 수 · 누르면 그 구간만</small></div>
      <div className="rq-steps" aria-hidden>
        {STAGE_GROUPS.map((group) => <span key={group.step} style={{ gridColumn: `span ${group.stages.length}` }}><b>{group.step}</b>{group.title}</span>)}
      </div>
      <nav aria-label="심사 구간" className="rq-rail">
        {STAGE_GROUPS.flatMap((group) => group.stages).map((item) => {
          const count = counts[item.key];
          return (
            <Link key={item.key} href={stageHref(stage, item.key)} aria-current={stage === item.key ? "page" : undefined} title={item.hint}
              data-zero={count === 0 || undefined} data-tone={item.key === "human" && count > 500 ? "warn" : undefined}>
              <span className="t">{item.label}</span>
              <span className="n">{n(count)}
                {item.key === "published" && <span
                  className={publication.net < 0 ? "text-down" : publication.net > 0 ? "text-up" : "text-fg-3"}
                  title={`최근 24시간: 발행 완료로 ${publication.added}건 이동, ${publication.removed}건 이탈`}
                  aria-label={`최근 24시간 발행 완료 ${publication.net >= 0 ? "+" : ""}${publication.net}건`}>
                  ({publication.net >= 0 ? "+" : ""}{n(publication.net)})
                </span>}
              </span>
              <span className="s">{sub(item.key, item.hint)}</span>
            </Link>
          );
        })}
      </nav>
    </section>
  );
}
