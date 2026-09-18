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
        note="여기는 “무엇을 찾아올지”를 정합니다. GitHub 검색으로 후보 레포를 주워 오는 단계라, 여기서 안 주운 것은 뒤에서 아무리 기준을 고쳐도 목록에 오르지 않습니다."
      >
        <div>
          <span className={label}>검색 신호</span>
          <p className={hint}>
            “신호”는 AI로 만든 것을 찾아내는 단서 하나입니다. 예를 들어 커밋 메시지의
            <code className="mx-1 font-mono">Co-authored-by: Claude</code>나 레포에 달린
            <code className="mx-1 font-mono">topic:vibe-coding</code>이 그렇습니다. 신호마다 건지는
            양과 質이 달라서 하나씩 끄고 켜며 비교할 수 있게 해 뒀습니다.
            <br />
            마지막 빈 행에 적으면 신호가 늘고, 이름이나 검색어를 지우면 그 신호가 빠집니다.
            우선순위는 먼저 조사할 순서입니다(높을수록 먼저).
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
            <p className={hint}>
              며칠 안에 손댄 레포까지 볼지. 3이면 최근 3일 안에 커밋된 것만 찾습니다.
              늘리면 한 번에 더 넓게 훑지만 이미 본 것을 다시 만나고, 줄이면 갓 만들어진 것만 봅니다.
            </p>
          </div>
          <div>
            <label className={label} htmlFor="sort">정렬</label>
            <select id="sort" name="sort" defaultValue={discover.sort} className={`${field} mt-1.5`}>
              <option value="relevance">관련도</option>
              <option value="recent">최신순</option>
            </select>
            <p className={hint}>
              검색 결과를 어떤 순서로 받을지. <b>관련도</b>는 여러 레포에 고루 퍼지고,
              <b>최신순</b>은 방금 활발히 커밋한 몇몇 레포에 몰립니다.
              실측: 같은 100건에서 서로 다른 레포가 관련도 63개 vs 최신순 2개.
            </p>
          </div>
          <div>
            <label className={label} htmlFor="pagesPerTick">틱당 페이지</label>
            <input id="pagesPerTick" name="pagesPerTick" type="number" min={1} max={10} defaultValue={discover.pagesPerTick} className={`${field} mt-1.5`} />
            <p className={hint}>
              한 번 돌 때 검색 결과를 몇 페이지까지 넘길지. <b>한 페이지가 검색 1회</b>이고
              수집은 10분마다 돕니다. 올리면 새 레포를 그만큼 빨리 찾습니다.
              <br />
              GitHub 검색 한도는 분당 30회인데, 2로 두면 10분에 2회라 한도의 1%도 안 씁니다
              (실측: 한도에 걸린 기록 0건). 10으로 올려도 3% 수준입니다.
            </p>
          </div>
        </div>
      </Panel>

      <Panel
        title="판정 기준"
        note="여기는 “주워 온 것 중 무엇을 올릴지”를 정합니다. 원본을 보관하므로 이 값을 바꾸면 GitHub을 다시 긁지 않고 곧바로 다시 판정합니다 — 기준을 바꿔 보는 비용이 거의 없습니다. 이미 발행된 것은 건드리지 않습니다(재검수 화면에서 따로 봅니다)."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className={label} htmlFor="maxStars">스타 상한</label>
            <input id="maxStars" name="maxStars" type="number" min={0} defaultValue={judge.maxStars} className={`${field} mt-1.5`} />
            <p className={hint}>
              별이 이 수를 넘는 레포는 거릅니다. 우리가 찾는 것은 개인이 AI로 만든 것이라,
              별이 수천 개인 대형 오픈소스는 대상이 아닙니다.
              <br />
              올리면 큰 프로젝트까지 들어오고(사실상 끄는 것), 내리면 입소문 난 개인 제품이 빠집니다.
            </p>
          </div>
          <div>
            <label className={label} htmlFor="minStars">스타 하한</label>
            <input id="minStars" name="minStars" type="number" min={0} defaultValue={judge.minStars} className={`${field} mt-1.5`} />
            <p className={hint}>
              별이 이 수보다 적으면 거릅니다. <b>0을 권합니다</b> — 갓 배포한 제품은 정당하게
              별이 0개라서, 올리는 순간 우리가 가장 찾고 싶은 것부터 사라집니다.
            </p>
          </div>
          <div>
            <label className={label} htmlFor="maxPushAgeDays">방치 기준(일)</label>
            <input id="maxPushAgeDays" name="maxPushAgeDays" type="number" min={1} max={3650} defaultValue={judge.maxPushAgeDays} className={`${field} mt-1.5`} />
            <p className={hint}>
              마지막 커밋이 이보다 오래되면 죽은 프로젝트로 봅니다.
              다만 실측에서 여기 걸린 31건의 주소가 <b>전부 살아 있었습니다</b> — 다 만들고 손을
              뗀 것도 있어서, 너무 짧게 잡으면 멀쩡한 제품이 빠집니다.
            </p>
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
            <p className={hint}>
              레포의 배포 주소가 이 도메인이면 <b>제품이 아니라 제품의 소개·등록 페이지</b>로 봅니다.
              npm 패키지 페이지나 GitHub 저장소 주소를 제품으로 올리지 않기 위한 것입니다.
              한 줄에 하나, 하위 도메인도 함께 걸립니다.
            </p>
            <textarea
              id="blockedHomepageDomains"
              name="blockedHomepageDomains"
              rows={8}
              defaultValue={judge.blockedHomepageDomains.join("\n")}
              className={`${field} mt-1.5 font-mono`}
            />
          </div>
          <div>
            <label className={label} htmlFor="thirdPartyHosts">남의 사이트 주소</label>
            <p className={hint}>
              제작자가 만든 곳이 아니라 <b>남의 서비스에 올려 둔 글·초대·양식</b>인 주소입니다
              (Substack 글, Discord 초대, Google 양식 등). 그 주소는 제품이 아니라 제품 이야기입니다.
              주소 뒤쪽이 일치하면 걸립니다. 한 줄에 하나.
            </p>
            <textarea
              id="thirdPartyHosts"
              name="thirdPartyHosts"
              rows={8}
              defaultValue={judge.thirdPartyHosts.join("\n")}
              className={`${field} mt-1.5 font-mono`}
            />
          </div>
          <div>
            <label className={label} htmlFor="stubPageTitles">빈 페이지·대기 화면 제목</label>
            <p className={hint}>
              열어 봤더니 제품이 아니라 <b>로그인 화면·공사 중 안내·404</b>인 경우를 제목으로 걸러냅니다.
              배포 주소는 살아 있어도 쓸 수 있는 것이 없는 경우입니다.
              <code className="mx-1 font-mono">*</code>를 쓸 수 있고, 한 줄에 하나.
            </p>
            <textarea
              id="stubPageTitles"
              name="stubPageTitles"
              rows={8}
              defaultValue={judge.stubPageTitles.join("\n")}
              className={`${field} mt-1.5 font-mono`}
            />
          </div>
          <div>
            <label className={label} htmlFor="excludedRepoPatterns">레포명 제외 패턴</label>
            <p className={hint}>
              레포 이름이 이 모양이면 제품이 아니라고 봅니다 — 링크 모음(<code className="mx-1 font-mono">awesome-*</code>),
              설정 파일 저장소(<code className="mx-1 font-mono">dotfiles</code>), 회사 소개 사이트
              (<code className="mx-1 font-mono">*-website</code>) 같은 것들입니다.
              <br />
              이력·포트폴리오·개인 홈페이지는 여기 걸려도 거부되지 않고 <b>개인프로필</b>로 발행됩니다.
              <code className="mx-1 font-mono">*</code>를 쓸 수 있고, 한 줄에 하나.
            </p>
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

      <Panel
        title="2차 심사"
        note="1차 AI가 확정한 것·위험 신호가 있는 것·규칙만 통과한 공개분 일부를 다른 모델이 다시 봅니다. 결과는 제안일 뿐 판정을 바꾸지 않습니다."
      >
        <fieldset className="mb-4">
          <legend className={label}>다시 볼 모델 (최대 3)</legend>
          <p className={hint}>
            성향이 서로 다른 모델을 세울수록 좋습니다 — 관대한 모델과 엄격한 모델이 같은 결론을 내면 실수가 상쇄됩니다.
            게이트웨이는 모델 목록이 바뀝니다. 없는 모델을 적으면 그 표만 실패로 남고 운영센터에 뜹니다.
          </p>
          <div className="mt-2 grid gap-2">
            {[0, 1, 2].map((index) => {
              const voter = settings.secondReview.voters[index];
              /*
               * 키에 내용을 넣는다. 순번만 쓰면 칸을 지웠을 때 다음 칸이 이 DOM 을 물려받는데,
               * 다루지 않는(uncontrolled) select 는 defaultValue 가 바뀌어도 다시 그려지지 않아
               * 남은 모델이 앞 칸의 제공자를 뒤집어쓴다 — 검색 신호 행이 같은 이유로 이렇게 한다.
               */
              return (
                <div key={`${index}:${voter?.provider ?? ""}:${voter?.model ?? ""}`} className="flex flex-wrap items-center gap-2">
                  <select name={`voterProvider${index}`} aria-label={`${index + 1}번째 표 부르는 곳`}
                    defaultValue={voter?.provider ?? "abcllm"} className={`${field} w-auto`}>
                    <option value="claude-cli">Claude CLI (한도 있음)</option>
                    <option value="abcllm">사내 게이트웨이 (한도 없음)</option>
                  </select>
                  <input name={`voterModel${index}`} aria-label={`${index + 1}번째 표 모델`} defaultValue={voter?.model ?? ""}
                    placeholder={index === 0 ? "opus" : "[MLX] gemma4-26b — 비우면 세우지 않습니다"}
                    className={`${field} min-w-[220px] flex-1 font-mono`} />
                </div>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="mb-4">
          <legend className={label}>실패 시 대체 모델 (순서대로 최대 2)</legend>
          <p className={hint}>시간 초과나 응답 오류에만 사용합니다. 대체 시도를 포함해 3회 실패하면 사람 확인으로 넘깁니다. 1차와 같은 모델의 대체 결과는 참고 의견이며, 독립 표로 세지 않고 사람 확인이 필요합니다.</p>
          <div className="mt-2 grid gap-2">
            {[0, 1].map(index => {
              const fallback = settings.secondReview.fallbacks?.[index];
              return <div key={`${index}:${fallback?.provider ?? ""}:${fallback?.model ?? ""}`} className="flex flex-wrap items-center gap-2">
                <select name={`fallbackProvider${index}`} aria-label={`${index + 1}번째 대체 제공자`} defaultValue={fallback?.provider ?? "claude-cli"} className={`${field} w-auto`}>
                  <option value="claude-cli">Claude CLI</option><option value="abcllm">사내 게이트웨이</option>
                </select>
                <input name={`fallbackModel${index}`} aria-label={`${index + 1}번째 대체 모델`} defaultValue={fallback?.model ?? ""}
                  placeholder="비우면 사용하지 않습니다" className={`${field} min-w-[220px] flex-1 font-mono`} />
              </div>;
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="secondReviewSamplePercent">공개분 표본 (%)</label>
            <input
              id="secondReviewSamplePercent"
              name="secondReviewSamplePercent"
              type="number"
              min={0}
              max={50}
              step={1}
              defaultValue={Math.round(settings.secondReview.sampleRate * 100)}
              className={`${field} mt-1.5`}
            />
            <p className={hint}>규칙만 통과해 공개된 것 중 다시 볼 비율</p>
          </div>
          <div>
            <label className={label} htmlFor="secondReviewAgreeAt">일치 기준 확신</label>
            <input
              id="secondReviewAgreeAt"
              name="secondReviewAgreeAt"
              type="number"
              min={0.5}
              max={1}
              step={0.05}
              defaultValue={settings.secondReview.agreeAt}
              className={`${field} mt-1.5`}
            />
            <p className={hint}>두 판단이 같고 둘 다 이 값 이상이면 한 번에 확정할 수 있게 묶습니다</p>
          </div>
        </div>
        <div className="mt-4">
          <Toggle name="secondReviewIncludeAiHeld" defaultChecked={settings.secondReview.includeAiHeld}>
            1차 AI도 못 가른 것까지 본다
            <span className="ml-1 text-fg-3">— 1차가 표를 내지 않으므로 세워 둔 모델 둘이 같은 결론을 내야 일치가 됩니다</span>
          </Toggle>
          <Toggle name="secondReviewEnabled" defaultChecked={settings.secondReview.enabled}>
            2차 심사 켜기
            <span className="ml-1 text-fg-3">— 끄면 새로 쌓지 않습니다. 이미 받은 결과는 그대로 보입니다</span>
          </Toggle>
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
