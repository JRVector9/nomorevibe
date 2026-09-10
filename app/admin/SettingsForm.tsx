"use client";

import { useActionState } from "react";
import { saveCrawlSettings, type SaveState } from "./actions";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { Panel } from "@/components/Panel";

const field = "w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px] text-fg outline-none focus:border-accent";
const label = "block text-[13px] font-semibold text-fg-2";
const hint = "mt-1 text-[13px] leading-[1.6] text-fg-3";

function Toggle({ name, defaultChecked, children }: { name: string; defaultChecked: boolean; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2.5 text-[13px]">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 accent-[var(--accent)]" />
      <span>{children}</span>
    </label>
  );
}

/**
 * 신호를 더하는 유일한 길 — 목록 끝의 빈 행.
 *
 * 저장된 신호 목록이 코드 기본값을 통째로 덮으므로(settings.ts), 기본 신호를 새로 넣어도
 * 이미 저장된 환경에는 닿지 않는다. 빈 행이 없던 동안 남은 길은 판정 기준까지 함께
 * 되돌리는 "기본값으로 되돌리기"뿐이었다. 라벨이나 검색어가 비면 서버 액션이 버리므로
 * (actions.ts) 그냥 저장을 눌러도 신호가 늘지 않는다.
 */
const BLANK_QUERY = {
  label: "",
  kind: "commits" as const,
  query: "",
  enabled: false,
  priority: 0,
  builder: null,
};

export function SettingsForm({ settings }: { settings: CrawlSettings }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveCrawlSettings, null);
  const { discover, judge } = settings;
  const queryRows = [...discover.queries, BLANK_QUERY];

  return (
    <form action={action} className="mt-6 flex flex-col gap-4">
      {state?.issues && state.issues.length > 0 && (
        <div className="rounded-[10px] border border-down/40 bg-down/10 px-4 py-3 text-[13px] text-down">
          {state.issues.map((issue) => (
            <div key={issue}>{issue}</div>
          ))}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-[10px] border border-up/40 bg-up/10 px-4 py-3 text-[13px] text-up">
          저장했습니다. 다음 틱부터 적용됩니다.
        </div>
      )}

      <Panel
        title="수집 스위치"
        note="무언가 잘못 돌 때 배포 없이 끊을 수 있어야 합니다. 끄면 discover 작업이 아무것도 하지 않습니다."
      >
        <Toggle name="enabled" defaultChecked={settings.enabled}>
          수집을 켠다
        </Toggle>
      </Panel>

      <Panel
        title="검색 기준"
        note="GitHub이 검색 시점에 걸러주는 것들입니다. 커밋 검색에는 스타·언어 수식어가 없어 날짜만 쓸 수 있습니다."
      >
        <div>
          <span className={label}>검색 신호</span>
          <p className={hint}>
            신호별 수율을 비교하려면 개별로 끌 수 있어야 합니다. 마지막 빈 행에 적으면 신호가
            늘고, 이름이나 검색어를 지우면 그 신호가 빠집니다.
          </p>
          <input type="hidden" name="queryCount" value={queryRows.length} />
          <div className="mt-3 flex flex-col gap-2">
            {/*
              키를 순번으로 잡으면 저장 뒤 빈 행의 DOM 노드가 새 행으로 재사용되고,
              defaultValue는 다시 적용되지 않아 낡은 값이 그대로 남는다. 다음 저장이 그것을
              제출해 방금 고른 검색 종류가 조용히 되돌아간다 (실제로 topic 신호가 커밋 검색으로
              바뀌었다). 행의 내용을 키에 넣어 값이 바뀌면 다시 그리게 한다.
            */}
            {queryRows.map((q, i) => (
              <div key={`${i}:${q.label}:${q.query}:${q.kind}`} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_auto_1.6fr_auto_auto_auto]">
                <input name={`query.${i}.label`} defaultValue={q.label} className={field} placeholder="이름" />
                <select
                  name={`query.${i}.kind`}
                  defaultValue={q.kind}
                  className={field}
                  title="커밋 검색은 트레일러를, 레포 검색은 topic 같은 레포 수식어를 찾습니다. 레포 검색은 배포 URL이 없는 레포를 넣지 않습니다."
                >
                  <option value="commits">커밋</option>
                  <option value="repositories">레포</option>
                </select>
                <input name={`query.${i}.query`} defaultValue={q.query} className={`${field} font-mono`} placeholder="검색 문자열" />
                <input
                  name={`query.${i}.builder`}
                  defaultValue={q.builder ?? ""}
                  className={`${field} sm:w-28`}
                  placeholder="추정 AI"
                  title="이 신호로 찾은 제품에 '우리 추정'으로 붙일 만든 AI. 비우면 추정하지 않습니다."
                />
                <input
                  name={`query.${i}.priority`}
                  defaultValue={q.priority}
                  type="number"
                  min={0}
                  max={1000}
                  className={`${field} sm:w-24`}
                  title="조사 우선순위"
                />
                <label className="flex items-center gap-2 whitespace-nowrap text-[13px]">
                  <input type="checkbox" name={`query.${i}.enabled`} defaultChecked={q.enabled} className="accent-[var(--accent)]" />
                  사용
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className={label} htmlFor="windowDays">최근 며칠</label>
            <input id="windowDays" name="windowDays" type="number" min={1} max={3650} defaultValue={discover.windowDays} className={`${field} mt-1.5`} />
          </div>
          <div>
            <label className={label} htmlFor="sort">정렬</label>
            <select id="sort" name="sort" defaultValue={discover.sort} className={`${field} mt-1.5`}>
              <option value="relevance">관련도</option>
              <option value="recent">최신순</option>
            </select>
            <p className={hint}>실측: 같은 100건에서 고유 레포가 관련도 63개 vs 최신순 2개</p>
          </div>
          <div>
            <label className={label} htmlFor="pagesPerTick">틱당 페이지</label>
            <input id="pagesPerTick" name="pagesPerTick" type="number" min={1} max={10} defaultValue={discover.pagesPerTick} className={`${field} mt-1.5`} />
            <p className={hint}>검색 한도가 30회/분입니다</p>
          </div>
        </div>
      </Panel>

      <Panel
        title="판정 기준"
        note="수집한 레포 메타로 우리가 거르는 것들입니다. 원본을 보관하므로 이 값을 바꾸면 GitHub을 다시 긁지 않고 재판정됩니다."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className={label} htmlFor="maxStars">스타 상한</label>
            <input id="maxStars" name="maxStars" type="number" min={0} defaultValue={judge.maxStars} className={`${field} mt-1.5`} />
            <p className={hint}>넘으면 개인이 AI로 만든 제품이 아니라고 봅니다</p>
          </div>
          <div>
            <label className={label} htmlFor="minStars">스타 하한</label>
            <input id="minStars" name="minStars" type="number" min={0} defaultValue={judge.minStars} className={`${field} mt-1.5`} />
            <p className={hint}>갓 배포한 제품은 0개입니다. 올리면 찾으려는 것부터 걸러집니다</p>
          </div>
          <div>
            <label className={label} htmlFor="maxPushAgeDays">방치 기준(일)</label>
            <input id="maxPushAgeDays" name="maxPushAgeDays" type="number" min={1} max={3650} defaultValue={judge.maxPushAgeDays} className={`${field} mt-1.5`} />
            <p className={hint}>마지막 푸시가 이보다 오래되면 죽은 프로젝트로 봅니다</p>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <Toggle name="excludeForks" defaultChecked={judge.excludeForks}>포크 제외</Toggle>
          <Toggle name="excludeOrganizations" defaultChecked={judge.excludeOrganizations}>
            조직 계정 제외
            <span className="ml-1 text-fg-3">— 개인이 조직 계정을 쓰는 경우도 있어 놓치는 것이 생깁니다</span>
          </Toggle>
          <Toggle name="holdAmbiguous" defaultChecked={judge.holdAmbiguous}>
            애매하면 보류
            <span className="ml-1 text-fg-3">— 끄면 애매한 것을 바로 거부합니다</span>
          </Toggle>
          {/*
            근거를 모으는 것과 그것을 발행 조건으로 삼는 것은 다른 결정이다.
            모으기만 하면 판정은 그대로이므로 먼저 켜서 무엇이 쌓이는지 볼 수 있다.
          */}
          <Toggle name="agentEvidenceEnabled" defaultChecked={settings.agentEvidence.enabled}>
            개발 AI 근거 수집
            <span className="ml-1 text-fg-3">— AGENTS.md·설정 파일·커밋 표기를 모읍니다. 판정은 바뀌지 않습니다</span>
          </Toggle>
          <Toggle name="agentEvidenceEnforce" defaultChecked={settings.agentEvidence.enforceEligibility}>
            근거를 발행 조건으로 사용
            <span className="ml-1 text-fg-3">— 켜면 근거가 기준에 못 미치는 후보를 보류합니다. 수집을 먼저 켜세요</span>
          </Toggle>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="blockedHomepageDomains">차단 도메인</label>
            <p className={hint}>homepage가 이 도메인이면 배포물이 아닙니다. 한 줄에 하나.</p>
            <textarea
              id="blockedHomepageDomains"
              name="blockedHomepageDomains"
              rows={8}
              defaultValue={judge.blockedHomepageDomains.join("\n")}
              className={`${field} mt-1.5 font-mono`}
            />
          </div>
          <div>
            <label className={label} htmlFor="excludedRepoPatterns">레포명 제외 패턴</label>
            <p className={hint}>* 와일드카드를 씁니다. 한 줄에 하나.</p>
            <textarea
              id="excludedRepoPatterns"
              name="excludedRepoPatterns"
              rows={8}
              defaultValue={judge.excludedRepoPatterns.join("\n")}
              className={`${field} mt-1.5 font-mono`}
            />
          </div>
        </div>
      </Panel>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[10px] bg-accent-solid px-5 py-2.5 text-[13.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {pending ? "저장 중…" : "저장"}
        </button>
      </div>
    </form>
  );
}
