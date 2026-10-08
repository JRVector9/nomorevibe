import Link from "next/link";
import { FLOW_NOTE, humanFlowLabel, humanWaitLabel, WAIT_REFERENCE, type HumanQueueOverview } from "@/lib/crawl/human-queue";
import { STAGE_GROUPS, stageHref, type StageKey } from "./stages";

const n = (value: number) => value.toLocaleString("ko-KR");

/**
 * 심사 구간 — 후보가 파이프라인의 어디에 서 있는가(stages.ts). 여덟 칸을 한 줄에, 위에 단계 이름.
 *
 * 칸은 겹치지 않아 보류 칸들의 합이 보류 수다. 사람 몫(직접 판단)은 가장 오래 기다린 날수와 24시간 흐름을 적어
 * 줄고 있는지 늘고 있는지가 숫자 하나로 보인다. 500건을 넘으면 주황. 사람 몫의 문구는 운영센터 파이프라인과 같은
 * 함수(human-queue.ts)로 만든다.
 */
export function ReviewStageRail({ stage, counts, overview, publication }: {
  stage: StageKey | ""; counts: Record<StageKey, number>; overview: HumanQueueOverview;
  publication: { added: number; removed: number; net: number };
}) {
  const sub = (key: StageKey, hint: string) => key === "agreed" ? `거부 ${n(overview.agreed.reject)} · 승인 ${n(overview.agreed.approve)}`
    : key === "published" ? "괄호는 최근 24시간 순증감"
    : key === "human" ? `${humanWaitLabel(overview)} · ${humanFlowLabel(overview)}`
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
            <Link key={item.key} href={stageHref(stage, item.key)} aria-current={stage === item.key ? "page" : undefined}
              title={item.key === "human" ? `${item.hint} · 대기는 ${WAIT_REFERENCE} · ${FLOW_NOTE}` : item.hint}
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
