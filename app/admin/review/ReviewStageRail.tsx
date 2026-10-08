import Link from "next/link";
import { FLOW_NOTE, humanFlowLabel, humanWaitLabel, WAIT_REFERENCE, type HumanQueueOverview } from "@/lib/crawl/human-queue";
import { STAGE_GROUPS, stageHref, type StageKey } from "./stages";

const n = (value: number) => value.toLocaleString("ko-KR");

/** 구간 탭 뒤에 붙는 할 일 탭 — 구간이 아닌 곳(2차가 다시 본 공개분 등)으로 가는 지름길 */
export type TodoTab = { key: string; label: string; count: number; href: string; title: string; active: boolean; tone?: "ok" | "warn" | "bad" };

/**
 * 심사 구간 — 후보가 파이프라인의 어디에 서 있는가(stages.ts). 한 줄짜리 탭(구간명 + 수)이다(2026-10-08 UX 감사 ADM-09).
 *
 * 전에는 여덟 칸 레일 아래 할 일 카드 네 장이 같은 곳(확정만 하면 됨·직접 판단)을 다시 가리켜 표가 첫 화면 밖에서 시작했다.
 * 할 일은 그 탭의 배지로 합쳤다 — 확정만 하면 됨은 거부·승인 수(초록), 직접 판단은 가장 오래 기다린 날수(500건 넘으면 주황).
 * 단계 이름·24시간 흐름 같은 설명은 탭의 title 로 내렸다. 칸은 겹치지 않아 보류 탭들의 합이 보류 수다.
 * 사람 몫의 문구는 운영센터 파이프라인과 같은 함수(human-queue.ts)로 만든다.
 */
export function ReviewStageRail({ stage, counts, overview, publication, todo = [], humanDetail }: {
  stage: StageKey | ""; counts: Record<StageKey, number>; overview: HumanQueueOverview;
  publication: { added: number; removed: number; net: number };
  todo?: TodoTab[];
  /** 직접 판단 탭의 title 에 덧붙일 갈래 수(2차 갈림·소개 없음 등) */
  humanDetail?: string;
}) {
  const badge = (key: StageKey): { text: string; tone?: "ok" | "warn" } | null => {
    if (key === "agreed") return { text: `거부 ${n(overview.agreed.reject)} · 승인 ${n(overview.agreed.approve)}`, tone: counts.agreed > 0 ? "ok" : undefined };
    if (key === "human") return counts.human > 0 ? { text: humanWaitLabel(overview).replace("판정 뒤 ", ""), tone: counts.human > 500 ? "warn" : undefined } : null;
    return null;
  };
  return (
    <nav aria-label="심사 구간" className="rq-tabs">
      {STAGE_GROUPS.flatMap((group) => group.stages.map((item) => ({ ...item, group }))).map((item) => {
        const count = counts[item.key];
        const mark = badge(item.key);
        const title = [`${item.group.step} ${item.group.title} · ${item.hint}`,
          item.key === "human" ? `${humanWaitLabel(overview)} · ${humanFlowLabel(overview)} · 대기는 ${WAIT_REFERENCE} · ${FLOW_NOTE}${humanDetail ? ` · ${humanDetail}` : ""}` : null,
          item.key === "published" ? "괄호는 최근 24시간 순증감" : null].filter(Boolean).join("\n");
        return (
          <Link key={item.key} href={stageHref(stage, item.key)} aria-current={stage === item.key ? "page" : undefined} title={title}
            data-zero={count === 0 || undefined} data-tone={item.key === "human" && count > 500 ? "warn" : undefined}>
            <span className="t">{item.label}</span>
            <span className="n">{n(count)}</span>
            {item.key === "published" && <span
              className={`d ${publication.net < 0 ? "text-down" : publication.net > 0 ? "text-up" : "text-fg-3"}`}
              title={`최근 24시간: 발행 완료로 ${publication.added}건 이동, ${publication.removed}건 이탈`}
              aria-label={`최근 24시간 발행 완료 ${publication.net >= 0 ? "+" : ""}${publication.net}건`}>
              ({publication.net >= 0 ? "+" : ""}{n(publication.net)})
            </span>}
            {mark && <span className="b" data-tone={mark.tone}>{mark.text}</span>}
          </Link>
        );
      })}
      {todo.length > 0 && <span className="sep" aria-hidden />}
      {todo.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={tab.active ? "page" : undefined} title={tab.title}
          data-zero={tab.count === 0 || undefined} data-tone={tab.tone}>
          <span className="t">{tab.label}</span>
          <span className="n">{n(tab.count)}</span>
        </Link>
      ))}
    </nav>
  );
}
