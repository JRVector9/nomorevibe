"use client";

import { useActionState, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { saveCrawlSettings, type SaveState } from "./actions";
import { ConfirmAction } from "./components/ConfirmAction";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { describeChanges, formValues, type FieldValues } from "./settings/changes";
import { searchUsage, SEED_INTERVAL_MINUTES } from "./settings/model";
import { FilterLists } from "./settings/FilterLists";
import { ModelRows } from "./settings/ModelRows";
import { SignalsTable, type SignalYieldView } from "./settings/SignalsTable";
import { chipClass, hintClass, inputBase, inputClass, labelClass, SettingsCard, Switch } from "./settings/Switch";

/** 2026-09-18 실측(사내 게이트웨이) — 동시 실행 수마다 성공률과 처리량 */
const MEASURED = [
  { at: 2, perHour: 119, note: "성공 99%" },
  { at: 4, perHour: 225, note: "성공 94% · 남는 몫으로 감사" },
  { at: 6, perHour: 156, note: "성공 87% · 실패가 늘어 더 느림" },
];

const REVIEW_MODE_LABELS: Record<CrawlSettings["reviewMode"], string> = { off: "꺼짐", observe: "관측", enforce: "적용" };

const segment = "relative flex cursor-pointer items-center gap-1.5 border-l border-line px-3 py-2 text-[13px] font-semibold text-fg-3 first:border-l-0 has-[:checked]:bg-fg has-[:checked]:text-bg";

function Segmented({ name, label, options, defaultValue }: {
  name: string; label: string; options: { value: string; label: string }[]; defaultValue: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-fit overflow-hidden rounded-[9px] border border-line">
      {options.map((option) => (
        <label key={option.value} className={segment}>
          <input type="radio" name={name} value={option.value} defaultChecked={defaultValue === option.value} className="absolute h-px w-px opacity-0" />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function ToggleRow({ name, defaultChecked, title, note }: { name: string; defaultChecked: boolean; title: string; note?: string }) {
  return (
    <div className="flex items-center gap-3 border-t border-bg-hover py-3 first:border-t-0">
      <Switch name={name} defaultChecked={defaultChecked} label={title} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">{title}</div>
        {note && <div className="text-[13px] text-fg-3">{note}</div>}
      </div>
    </div>
  );
}

function NumberField({ id, label, defaultValue, min, max, step, hint, suffix, onValue }: {
  id: string; label: React.ReactNode; defaultValue: number; min?: number; max?: number; step?: number;
  hint?: React.ReactNode; suffix?: string; onValue?: (value: number) => void;
}) {
  const input = <input id={id} name={id} type="number" min={min} max={max} step={step} defaultValue={defaultValue}
    onChange={onValue ? (event) => onValue(Number(event.target.value)) : undefined} className={inputClass} />;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* 라벨 높이를 맞춘다 — "권장 0" 칩이 붙은 라벨만 높아지면 그 칸의 입력이 옆 칸보다 내려간다 */}
      <label htmlFor={id} className={`${labelClass} flex min-h-6 items-center`}>{label}</label>
      {suffix ? <div className="flex items-center gap-2">{input}<span className={hintClass}>{suffix}</span></div> : input}
      {hint && <div className={hintClass}>{hint}</div>}
    </div>
  );
}

/**
 * 크롤 설정 폼 — 2026-10-08 리디자인(시안 https://claude.ai/artifact/SDW3BrHUfgDp1EsGof3cAB).
 *
 * 필드 이름과 서버 액션(saveCrawlSettings)은 그대로다. 바뀐 것은 배치와, 신호별 7일 성과·빠진 기본값 더하기·
 * 저장 바(무엇이 바뀌었는지)다. "되돌리기"는 폼을 처음 그린 값으로 다시 그린다.
 *
 * 2026-10-08 UX 감사 ADM-18: 저장 바는 화면 아래에 붙어 있고 바뀐 것이 있을 때만 도드라진다. 바뀐 값이 있으면
 * 창을 닫거나 다른 메뉴로 갈 때 묻는다. 수집 켜기·끄기는 폼에서 빼 운영센터 머리의 즉시 스위치로 옮겼다.
 * secondControls 는 저장 없이 바로 바뀌는 2차 심사 손잡이(발행 보호·2차 표)로, 2차 심사 칸에 들어간다(ADM-24).
 */
export function SettingsForm({ settings, version = "", yields = {}, secondControls }: {
  settings: CrawlSettings; version?: string; yields?: Record<string, SignalYieldView>; secondControls?: React.ReactNode;
}) {
  const [generation, setGeneration] = useState(0);
  return <SettingsFormBody key={generation} settings={settings} version={version} yields={yields} secondControls={secondControls}
    onRevert={() => setGeneration((g) => g + 1)} />;
}

/** 바뀐 값이 있는 채로 떠나려 할 때 묻는다 — 창 닫기·새로고침·외부 이동은 beforeunload, 관리자 안의 이동은 링크 클릭 */
function useLeaveGuard(dirty: boolean, onLeave: (href: string) => void) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    /*
     * Next 의 화면 이동(<Link>)은 beforeunload 를 부르지 않고, 이 판의 라우터에는 이동을 막는 전역 손잡이가 없다
     * (Link 의 onNavigate 는 링크마다 단다 — 사이드바 링크는 이 화면 것이 아니다). 그래서 문서에서 먼저(capture) 링크 클릭을 받아
     * 막고 확인 창을 띄운다. 새 탭·다운로드·바깥 주소·같은 화면 안 구획 이동(#signals)은 그대로 둔다.
     */
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      onLeave(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, onLeave]);
}

function SettingsFormBody({ settings, version, yields, secondControls, onRevert }: {
  settings: CrawlSettings; version: string; yields: Record<string, SignalYieldView>; secondControls?: React.ReactNode; onRevert: () => void;
}) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveCrawlSettings, null);
  const router = useRouter();
  /*
   * 폼이 그린 값의 판. 저장에 성공했을 때만 새 판으로 바꾼다 — 같은 화면의 2차 표 바로 바꾸기·기본값 되돌리기가 판을 바꿔도
   * 이 폼의 칸은 옛 값이라, 옛 판을 그대로 실어 저장이 거절되게 한다(옛 값으로 덮지 않는다).
   */
  const [formVersion, setFormVersion] = useState(version);
  const [leaving, setLeaving] = useState<string | null>(null);
  const { discover, judge, secondReview } = settings;
  const form = useRef<HTMLFormElement>(null);
  const [baseline, setBaseline] = useState<FieldValues | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [tick, touched] = useReducer((n: number) => n + 1, 0);
  const [pages, setPages] = useState(discover.pagesPerTick);
  const [concurrency, setConcurrency] = useState(settings.reviewConcurrency);

  // 처음 그린 값이 기준이다. 저장에 성공하면 그때 값이 새 기준이 된다
  useEffect(() => { if (form.current) setBaseline(formValues(form.current)); }, []);
  useEffect(() => {
    if (state?.ok && form.current) setBaseline(formValues(form.current));
    if (state?.version) setFormVersion(state.version);
  }, [state]);
  /*
   * 입력·칩·행이 바뀔 때마다 다시 견준다. 손대지 않는 입력은 상태가 없어 그린 뒤에 폼을 다시 읽는다 —
   * 폼의 입력·클릭이 tick 을 올리고, 같은 이벤트에서 바뀐 칩·행이 그려진 다음에 이 효과가 돈다.
   */
  useEffect(() => {
    if (!baseline || !form.current) return;
    const next = describeChanges(baseline, formValues(form.current));
    setChanges((current) => (current.join("|") === next.join("|") ? current : next));
  }, [baseline, tick]);

  const usage = searchUsage(pages);
  const summary = changes.length > 3 ? `${changes.slice(0, 3).join(" · ")} 외 ${changes.length - 3}개` : changes.join(" · ");
  const dirty = changes.length > 0;
  useLeaveGuard(dirty, setLeaving);

  return (
    <form ref={form} action={action} onInput={touched} onChange={touched} onClick={touched} className="flex min-w-0 flex-col gap-4">
      {/* 그린 값의 판 — 저장이 견줘 그 사이 다른 곳(다른 탭·심사 큐)에서 바뀐 값을 옛 값으로 덮지 않는다 */}
      <input type="hidden" name="settingsVersion" value={formVersion} />
      {/* 수집 켜기·끄기는 저장과 묶이면 안 된다 — 운영센터 머리에서 확인 창을 거쳐 바로 바꾼다(ADM-18). 여기서는 지금 상태만 */}
      <section className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-line bg-bg-card px-[22px] py-3 text-[14px]">
        <span className="font-semibold">수집 {settings.enabled ? "켜짐" : "꺼짐"}</span>
        <span className="text-[13px] text-fg-3">이 폼을 저장해도 바뀌지 않습니다</span>
        <Link prefetch={false} href="/admin/status" className="ml-auto text-[13px] font-semibold text-accent-ink hover:underline">운영센터에서 켜고 끄기 →</Link>
      </section>

      <SignalsTable discover={discover} yields={yields} />

      <SettingsCard id="scope" title="수집 범위" note="검색 한 번에 얼마나, 얼마 전 것까지 볼지">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField id="windowDays" label="최근 며칠" defaultValue={discover.windowDays} min={1} max={3650}
            hint={<>며칠 안에 커밋된 레포까지 볼지. 생성일이 아니라 활동일 기준이고, 미완 구간은 이어서 수집합니다.</>} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={labelClass}>정렬</span>
            <Segmented name="sort" label="정렬" defaultValue={discover.sort}
              options={[{ value: "recent", label: "최신 활동순" }, { value: "relevance", label: "관련도" }]} />
            <p className={hintClass}>뒤처지면 최신 구간부터 확인하고 미완 구간도 이어 갑니다. 관련도는 검색어와의 관련성을 우선합니다.</p>
          </div>
          <NumberField id="pagesPerTick" label="틱당 페이지" defaultValue={discover.pagesPerTick} min={1} max={10} onValue={setPages}
            hint={<span className="font-semibold text-up">{SEED_INTERVAL_MINUTES}분마다 {pages}회 → 시간당 {usage.perHour}회 · 한도의 {usage.percent}</span>} />
        </div>
      </SettingsCard>

      <SettingsCard id="judge" title="판정 기준" note="주워 온 것 중 무엇을 올릴지 — 바꾸면 GitHub 을 다시 긁지 않고 곧바로 다시 판정합니다. 이미 발행된 것은 건드리지 않습니다">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField id="autoApproveMinStars" label="자동 승인 최소 스타" defaultValue={judge.autoApproveMinStars} min={500} max={10000000}
            hint="24시간 안에 확인한 스타가 이 이상이면 1·2차 AI 심사 없이 발행합니다. 포크·보관·차단·수동 거부는 제외합니다." />
          <NumberField id="minStars" defaultValue={judge.minStars} min={0}
            label={<>스타 하한 <span className="ml-1 rounded-full bg-up/10 px-2 py-px text-[13px] font-semibold text-up">권장 0</span></>}
            hint="갓 배포한 제품은 정당하게 별이 0개입니다 — 올리는 순간 가장 찾고 싶은 것부터 사라집니다." />
          <NumberField id="maxPushAgeDays" label="방치 기준" defaultValue={judge.maxPushAgeDays} min={1} max={3650} suffix="일"
            hint="마지막 커밋이 이보다 오래되면 죽은 프로젝트로 봅니다. 너무 짧으면 다 만들고 손을 뗀 멀쩡한 제품이 빠집니다." />
        </div>
        <div className="flex flex-col">
          <ToggleRow name="excludeForks" defaultChecked={judge.excludeForks} title="포크 제외" />
          <ToggleRow name="excludeOrganizations" defaultChecked={judge.excludeOrganizations} title="조직 계정 제외"
            note="개인이 조직 계정을 쓰는 경우도 있어 놓치는 것이 생깁니다" />
          <ToggleRow name="holdAmbiguous" defaultChecked={judge.holdAmbiguous} title="애매하면 보류" note="끄면 애매한 것을 바로 거부합니다" />
          {/* 근거를 모으는 것과 그것을 발행 조건으로 삼는 것은 다른 결정이다 — 모으기만 하면 판정은 그대로다 */}
          <ToggleRow name="agentEvidenceEnabled" defaultChecked={settings.agentEvidence.enabled} title="개발 AI 근거 수집"
            note="AGENTS.md·설정 파일·커밋 표기를 모읍니다. 판정은 바뀌지 않습니다" />
          <ToggleRow name="agentEvidenceEnforce" defaultChecked={settings.agentEvidence.enforceEligibility} title="근거를 발행 조건으로 사용"
            note="켜면 근거가 기준에 못 미치는 후보를 보류합니다 — 수집을 먼저 켜세요" />
        </div>
      </SettingsCard>

      <FilterLists judge={judge} />

      <SettingsCard id="first" title="1차 심사" note="규칙이 통과시킨 후보를 AI가 한 번 더 봅니다 · 발행을 막을지(발행 보호)는 아래 2차 심사 칸에서 정합니다"
        actions={<a href="#second" className={`${chipClass} bg-bg-hover text-fg-2 hover:text-fg`}>발행 보호 {REVIEW_MODE_LABELS[settings.reviewMode]}</a>}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <span className={labelClass}>부르는 곳</span>
            <Segmented name="firstReviewProvider" label="1차 심사를 부르는 곳" defaultValue={settings.firstReview?.provider ?? "abcllm"}
              options={[{ value: "abcllm", label: "사내 게이트웨이 · 한도 없음" }, { value: "claude-cli", label: "Claude CLI · 한도 있음" }]} />
          </div>
          <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
            <label htmlFor="firstReviewModel" className={labelClass}>모델</label>
            <input id="firstReviewModel" name="firstReviewModel" defaultValue={settings.firstReview?.model ?? ""}
              placeholder="[MLX] gpt-oss-120b — 비우면 서버 기본값(CRAWL_REVIEW_MODEL)" className={`${inputClass} font-mono`} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reviewConcurrency" className={labelClass}>동시 실행 수</label>
          <div className="flex flex-wrap items-start gap-4">
            <input id="reviewConcurrency" name="reviewConcurrency" type="number" min={1} max={16} defaultValue={settings.reviewConcurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))} className={`${inputBase} w-24`} />
            <div className="grid min-w-0 flex-[1_1_420px] grid-cols-3 gap-2.5" aria-label="2026-09-18 실측">
              {MEASURED.map((row) => (
                <div key={row.at} className={`flex flex-col gap-0.5 rounded-[10px] border px-3 py-2.5 ${row.at === concurrency ? "border-accent bg-accent-soft" : "border-line"}`}>
                  <span className="text-[13px] text-fg-3">동시 {row.at}{row.at === concurrency ? " · 지금" : ""}</span>
                  <span className="text-[20px] font-semibold tabular-nums">{row.perHour}<span className="text-[13px] font-normal text-fg-3">건/시</span></span>
                  <span className="text-[13px] text-fg-3">{row.note}</span>
                </div>
              ))}
            </div>
          </div>
          <p className={hintClass}>실측 2026-09-18 · 사내 게이트웨이. 실패율이 오르면 한 단계 내리세요. 1차와 2차는 같은 워커가 차례로 돌려 겹치지 않습니다.</p>
        </div>
      </SettingsCard>

      <SettingsCard id="second" title="2차 심사" note="다른 모델이 다시 봅니다 · 결과는 제안일 뿐 판정을 바꾸지 않습니다"
        actions={<span className="flex items-center gap-2 text-[13px] font-semibold"><Switch name="secondReviewEnabled" defaultChecked={secondReview.enabled} label="2차 심사 켜기" />켜기</span>}>
        {secondControls && <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{secondControls}</div>}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={labelClass}>다시 볼 모델 <span className="font-normal text-fg-3">최대 3</span></span>
            <ModelRows prefix="voter" initial={secondReview.voters} max={3} placeholder="[supa] Qwen3.8-27B-NVFP4"
              addLabel="+ 모델 세우기 (성향이 다른 모델일수록 좋습니다)" />
            <p className={hintClass}>게이트웨이는 모델 목록이 바뀝니다. 없는 모델을 적으면 그 표만 실패로 남고 운영센터에 뜹니다.</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={labelClass}>실패 시 대체 <span className="font-normal text-fg-3">순서대로 최대 2</span></span>
            <ModelRows prefix="fallback" initial={secondReview.fallbacks ?? []} max={2} placeholder="qwen3-coder:30b" addLabel="+ 대체 모델 더하기" />
            <p className={hintClass}>시간 초과·응답 오류에만 씁니다. 세 번 실패하면 사람 확인으로 넘깁니다. 1차와 같은 모델의 대체 결과는 참고 의견입니다.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField id="secondReviewSamplePercent" label="공개분 표본" defaultValue={Math.round(secondReview.sampleRate * 100)} min={0} max={50} step={1}
            suffix="%" hint="규칙만 통과해 공개된 것 중 다시 볼 비율" />
          <NumberField id="secondReviewAgreeAt" label="일치 기준 확신" defaultValue={secondReview.agreeAt} min={0.5} max={1} step={0.05}
            hint="두 판단이 같고 둘 다 이 값 이상이면 한 번에 확정할 수 있게 묶습니다" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className={labelClass}>1차 AI도 못 가른 것</span>
            <div className="flex min-h-[38px] items-center gap-2.5">
              <Switch name="secondReviewIncludeAiHeld" defaultChecked={secondReview.includeAiHeld} label="1차 AI도 못 가른 것까지 본다" />
              <span className="text-[13px] text-fg-2">까지 본다</span>
            </div>
            <p className={hintClass}>켜면 1차가 표를 내지 않으므로 세운 모델 둘이 같아야 일치입니다</p>
          </div>
        </div>
      </SettingsCard>

      {/* 크롤 기준은 아니지만 배포 없이 바꾸는 운영 값이라 같은 설정 행에 둔다(settings-schema.ts rising) */}
      <SettingsCard id="public" title="공개 목록" note="홈·상세에 보이는 목록의 기준 · 저장하면 몇 분 안에(서버 캐시 1분 반, Cloudflare 사본 최대 2분) 공개 화면에 반영됩니다">
        <div className="max-w-[440px]">
          <NumberField id="risingFreshDays" label="지금 뜨는 프로젝트 · 마지막 스타 확인 기간" defaultValue={settings.rising.freshDays} min={1} max={30} suffix="일"
            hint="마지막 스타 확인이 이보다 오래된 제품은 뺍니다 — 지워졌거나 확인이 계속 실패하는 저장소가 빠집니다. 너무 짧으면 멀쩡한 제품도 빠집니다: 스타 갱신은 한 바퀴에 보통 2~3일 걸리고 밀리면 더 걸립니다. 기본 7일." />
        </div>
      </SettingsCard>

      {state?.issues && state.issues.length > 0 && (
        <div role="alert" className="rounded-[10px] border border-down/40 bg-down/10 px-4 py-3 text-[13px] text-down">
          {state.issues.map((issue) => <div key={issue}>{issue}</div>)}
        </div>
      )}
      {/* 4천 px 넘는 폼이라 저장 바를 화면 아래에 붙인다. 바뀐 것이 있을 때만 진하게 — 없으면 조용한 한 줄이다 */}
      <div data-dirty={dirty || undefined} aria-live="polite"
        className={`sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-[12px] border px-[18px] py-3.5 shadow-[0_-6px_18px_rgba(0,0,0,0.08)] ${
          dirty ? "border-fg bg-fg text-bg" : "border-line bg-bg-card text-fg-2"}`}>
        {dirty ? (<>
          <span className="text-[14px] font-semibold">바뀐 항목 {changes.length}개</span>
          <span className="min-w-0 text-[13px] opacity-75">{summary}</span>
        </>) : (
          <span className="text-[14px] font-semibold">{state?.ok ? "저장했습니다 — 위 '저장 판' 줄에서 워커 적용을 확인하세요" : "바뀐 것이 없습니다"}</span>
        )}
        <button type="button" disabled={pending || !dirty} onClick={onRevert}
          className="ml-auto inline-flex min-h-9 items-center rounded-[9px] border border-current/30 px-3.5 text-[13px] font-semibold disabled:opacity-40">되돌리기</button>
        <button type="submit" disabled={pending}
          className="inline-flex min-h-9 items-center rounded-[9px] bg-accent-solid px-4 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
          {pending ? "저장 중…" : "저장 — 다음 틱부터 적용"}
        </button>
      </div>
      <ConfirmAction open={leaving !== null} onOpenChange={(open) => { if (!open) setLeaving(null); }}
        title="저장하지 않은 변경이 있습니다" confirmLabel="저장하지 않고 떠나기"
        summary={<p className="text-[13px] text-fg-2">바뀐 항목 {changes.length}개({summary})가 사라집니다. 남기려면 취소하고 아래 저장 바에서 저장하세요.</p>}
        onConfirm={() => { if (leaving) router.push(leaving); }} />
    </form>
  );
}
