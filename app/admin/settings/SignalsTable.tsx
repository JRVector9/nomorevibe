"use client";

import { useState } from "react";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { buttonClass, chipClass, SettingsCard, Switch } from "./Switch";

type Query = CrawlSettings["discover"]["queries"][number];
export type SignalYieldView = { enqueued: number; published: number; gated: number };

/**
 * 저장된 신호 뒤에 빈 행을 하나 둔다 — 서버 액션이 라벨·검색어가 빈 행을 버리므로 그냥 저장해도 늘지 않는다.
 * "신호 추가"는 빈 행을 하나 더 붙일 뿐이다. 이름이나 검색어를 지우면 그 신호가 빠진다.
 */
const BLANK: Query = { label: "", kind: "commits", query: "", enabled: false, priority: 0, builder: null, requireEvidence: false };

const cell = "border-b border-bg-hover px-2.5 py-2.5 align-middle";
/** 너비 없는 칸 — 우선·추정 AI 처럼 너비를 정하는 칸이 w-full 과 겨루지 않게 나눈다(w-full 이 이기면 칸이 줄어 "1(" 처럼 잘렸다, ADM-17) */
const bareBase = "rounded-[7px] border border-transparent bg-transparent px-2 py-1 text-fg outline-none hover:border-line focus:border-accent focus:bg-bg-card";
const bare = `${bareBase} w-full min-w-0`;
/** 우선순위 입력 — 0~1000 네 자리와 숫자 단추가 들어가는 너비 */
const priorityInput = `${bareBase} w-[84px] shrink-0 text-right tabular-nums`;
const fmt = (n: number) => n.toLocaleString("ko-KR");

function Yield({ value }: { value?: SignalYieldView }) {
  if (!value || value.enqueued === 0) return <span className="text-[13px] text-fg-3">—</span>;
  const rate = value.published / value.enqueued;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-[88px] overflow-hidden rounded-full bg-bg-hover" aria-hidden>
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round(rate * 200))}%` }} />
        </div>
        <span className="min-w-[46px] text-[13px] tabular-nums">{(rate * 100).toFixed(1)}%</span>
      </div>
      {value.gated > 0 && <span className="text-[13px] text-warn">흔적 없어 보류 {fmt(value.gated)}</span>}
    </div>
  );
}

export function SignalsTable({ discover, yields }: { discover: CrawlSettings["discover"]; yields: Record<string, SignalYieldView> }) {
  // 우선순위가 높은 것부터 — 조사하는 순서와 같다. 저장하면 이 순서로 남는다(동작은 우선순위로만 정해진다)
  const [rows, setRows] = useState<Query[]>(() => [...[...discover.queries].sort((a, b) => b.priority - a.priority), BLANK]);
  const showHn = discover.showHn;
  const enabledCount = discover.queries.filter((q) => q.enabled).length + (showHn.enabled ? 1 : 0);
  const total = discover.queries.length + 1;
  // Show HN 은 우선순위 자리에 끼운다 — 전용 수집기(hn-show-seed)라 이름·검색어는 고칠 수 없다
  const showHnAt = rows.findIndex((row) => !row.label || row.priority < showHn.priority);

  const showHnRow = (
    <tr key="show-hn" className="[&:has(.signal-on:not(:checked))]:opacity-60">
      <td className={cell}><Switch name="showHn.enabled" defaultChecked={showHn.enabled} label="Show HN 사용" inputClassName="signal-on" /></td>
      <td className={`${cell} min-w-[240px]`}>
        <div className="px-2 font-semibold">Show HN</div>
        <div className="px-2 font-mono text-[13px] text-fg-3">news.ycombinator.com/show · 전용 수집</div>
      </td>
      <td className={cell}><span className="rounded-md bg-bg-hover px-2 py-0.5 text-[13px] font-semibold">Show HN</span></td>
      <td className={`${cell} text-fg-3`}>—</td>
      <td className={cell}>
        <input name="showHn.priority" type="number" min={0} max={1000} defaultValue={showHn.priority} aria-label="Show HN 우선순위"
          className={priorityInput} />
      </td>
      <td className={cell}>
        <input type="checkbox" name="showHn.requireEvidence" defaultChecked={showHn.requireEvidence ?? false} aria-label="Show HN AI 흔적 필요"
          className="h-4 w-4 accent-[var(--accent)]" />
      </td>
      <td className={`${cell} whitespace-nowrap text-right tabular-nums`}>{yields["Show HN"] ? fmt(yields["Show HN"].enqueued) : "—"}</td>
      <td className={cell}><Yield value={yields["Show HN"]} /></td>
    </tr>
  );

  return (
    <SettingsCard id="signals" title="검색 신호" note="AI로 만든 것을 찾는 단서 하나하나입니다. 높은 우선순위부터 조사합니다."
      actions={<>
        <span className={`${chipClass} bg-bg-hover text-fg-2`}>켜짐 {enabledCount} · 꺼짐 {total - enabledCount}</span>
        <button type="button" className={buttonClass} onClick={() => setRows((current) => [...current, BLANK])}>+ 신호 추가</button>
      </>}>
      <input type="hidden" name="queryCount" value={rows.length} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="text-left text-[13px] text-fg-3">
              {["사용", "신호 · 검색 문자열", "종류", "추정 AI", "우선", "AI 흔적", "7일 수집", "발행률"].map((heading) => (
                <th key={heading} scope="col" className={`whitespace-nowrap border-b border-line px-2.5 pb-2 font-semibold ${heading === "7일 수집" ? "text-right" : ""}`}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((q, i) => {
              /*
               * 키에 내용을 넣는다. 순번만 쓰면 저장 뒤 빈 행의 DOM 이 새 행으로 재사용되고 defaultValue 는
               * 다시 적용되지 않아 낡은 값이 남는다 — 다음 저장이 그것을 보내 고른 종류가 조용히 되돌아간다.
               */
              const row = (
                <tr key={`${i}:${q.label}:${q.query}:${q.kind}`} className="[&:has(.signal-on:not(:checked))]:opacity-60">
                  <td className={cell}><Switch name={`query.${i}.enabled`} defaultChecked={q.enabled} label={`${q.label || "새 신호"} 사용`} inputClassName="signal-on" /></td>
                  <td className={`${cell} min-w-[240px]`}>
                    <input name={`query.${i}.label`} defaultValue={q.label} placeholder="새 신호 이름" aria-label="신호 이름" className={`${bare} font-semibold`} />
                    <input name={`query.${i}.query`} defaultValue={q.query} placeholder="검색 문자열" aria-label="검색 문자열" className={`${bare} font-mono text-[13px] text-fg-2`} />
                  </td>
                  <td className={cell}>
                    <select name={`query.${i}.kind`} defaultValue={q.kind} aria-label="검색 종류"
                      title="커밋 검색은 트레일러를, 레포 검색은 topic 같은 레포 수식어를 찾습니다. 레포 검색은 배포 URL이 없는 레포를 넣지 않습니다."
                      className="rounded-md border border-transparent bg-bg-hover px-2 py-1 text-[13px] font-semibold outline-none hover:border-line focus:border-accent">
                      <option value="commits">커밋</option>
                      <option value="repositories">레포</option>
                    </select>
                  </td>
                  <td className={cell}>
                    <input name={`query.${i}.builder`} defaultValue={q.builder ?? ""} placeholder="—" aria-label="추정 AI"
                      title="이 신호로 찾은 제품에 '우리 추정'으로 붙일 만든 AI. 비우면 추정하지 않습니다." className={`${bareBase} w-[96px]`} />
                  </td>
                  <td className={cell}>
                    <input name={`query.${i}.priority`} type="number" min={0} max={1000} defaultValue={q.priority} aria-label="조사 우선순위"
                      className={priorityInput} />
                  </td>
                  <td className={cell}>
                    <input type="checkbox" name={`query.${i}.requireEvidence`} defaultChecked={q.requireEvidence ?? false} aria-label="AI 흔적 필요"
                      title="레포 루트의 CLAUDE.md·.cursor 같은 파일이나 최근 커밋의 Co-authored-by 가 없으면 들여보내지 않습니다."
                      className="h-4 w-4 accent-[var(--accent)]" />
                  </td>
                  <td className={`${cell} whitespace-nowrap text-right tabular-nums`}>{q.label && yields[q.label] ? fmt(yields[q.label].enqueued) : "—"}</td>
                  <td className={cell}><Yield value={q.label ? yields[q.label] : undefined} /></td>
                </tr>
              );
              return i === showHnAt ? [showHnRow, row] : [row];
            })}
          </tbody>
        </table>
      </div>
      <details className="text-[13px] text-fg-3">
        <summary className="cursor-pointer font-semibold text-accent-ink">커밋 신호와 레포 신호의 차이 · 자세히</summary>
        <p className="mt-2 max-w-[72ch] leading-[1.65]">
          커밋 신호는 커밋 메시지의 <code className="font-mono">Co-authored-by</code> 같은 트레일러를 찾고, 레포 신호는
          <code className="mx-1 font-mono">topic:</code>같은 레포 수식어를 찾습니다. 레포 신호는 배포 주소가 없는 레포를 넣지 않습니다.
          “AI 흔적”을 켠 신호는 레포 루트의 CLAUDE.md·.cursor 같은 파일이나 최근 커밋 표기가 없으면 들여보내지 않습니다 — 검색어가
          AI 사용을 말하지 않는 신호(한국어 README 등)에 켭니다. 이름이나 검색 문자열을 지우면 그 신호가 빠집니다.
          7일 수집·발행률은 지난 7일 이 신호로 들어온 후보와 그중 발행된 비율입니다.
        </p>
      </details>
    </SettingsCard>
  );
}
