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

export function SettingsForm({ settings }: { settings: CrawlSettings }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveCrawlSettings, null);
  const { discover, judge } = settings;

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
          <p className={hint}>신호별 수율을 비교하려면 개별로 끌 수 있어야 합니다.</p>
          <input type="hidden" name="queryCount" value={discover.queries.length} />
          <div className="mt-3 flex flex-col gap-2">
            {discover.queries.map((q, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_1.6fr_auto_auto]">
                <input name={`query.${i}.label`} defaultValue={q.label} className={field} placeholder="이름" />
                <input name={`query.${i}.query`} defaultValue={q.query} className={`${field} font-mono`} placeholder="검색 문자열" />
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
