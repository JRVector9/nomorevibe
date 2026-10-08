"use client";

import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { resolveTakedownRequest, resolveTakedownRequests, type BulkTakedownState, type ReviewState } from "../actions";
import { ConfirmAction } from "../components/ConfirmAction";
import { ScrollTable } from "../components/ScrollTable";
import { resultError, useAdminToast } from "../components/Toast";
import {
  DISMISS_REASONS, formatWait, groupTakedowns, senderLabel, waitTone,
  type GroupMode, type TakedownEntry,
} from "@/lib/domain/products/takedown-view";

const n = (value: number) => value.toLocaleString("ko-KR");
const KST = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "10-03 19:10" — 한국 시각 */
const kst = (iso: string) => {
  const parts = Object.fromEntries(KST.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};
const day = (iso: string) => (iso ? iso.slice(5, 10) : "—");
const GROUPS: [GroupMode, string][] = [["none", "없음"], ["owner", "같은 계정"], ["sender", "같은 보낸이"], ["time", "들어온 시각"]];
const SORTS = { oldest: "오래 기다린 것부터", newest: "막 들어온 것부터", visits: "방문 많은 것부터" } as const;
type Sort = keyof typeof SORTS;
const REMOVE_EFFECTS = [
  "사이트에서 곧바로 사라집니다 — 목록에서 빠지고 상세 페이지는 없는 페이지가 됩니다.",
  "같은 주소를 다시 수집하거나 등록할 수 없게 막힙니다.",
  "되돌리려면 제품 관리에서 한 건씩 풉니다.",
];

/**
 * 내려달라는 요청 처리 화면 — 내릴 후보의 첫 탭.
 *
 * 몇 건이 와도 한 화면에서 처리하도록: 같은 계정·같은 보낸이·같은 시각대로 묶어 묶음 머리에서 한 번에,
 * 체크한 것만 한 번에, 고른 한 건은 오른쪽에서 사유·계정·이력을 보고. 내리기는 되돌리기 번거로우니
 * 늘 이름을 한 번 훑는 확인을 거친다. 두기는 이유(테스트·장난 등)를 남긴다.
 */
export function TakedownQueue({ entries }: { entries: TakedownEntry[] }) {
  const [mode, setMode] = useState<GroupMode>("owner");
  const [sort, setSort] = useState<Sort>("oldest");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(entries[0]?.slug ?? null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [bulk, bulkAction, bulkPending] = useActionState<BulkTakedownState, FormData>(resolveTakedownRequests, null);
  const detailRef = useRef<{ confirmRemove: () => void; focusDismiss: () => void } | null>(null);
  const bulkFormRef = useRef<HTMLFormElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries.filter((entry) => !q || [entry.product?.name, entry.product?.url, entry.reason, entry.slug, entry.owner]
      .some((value) => value?.toLowerCase().includes(q)));
    return sort === "oldest" ? list : [...list].sort((a, b) => sort === "newest" ? a.ageHours - b.ageHours : b.visits7d - a.visits7d);
  }, [entries, query, sort]);
  const groups = useMemo(() => groupTakedowns(visible, mode), [visible, mode]);
  const order = groups.flatMap((group) => group.entries);
  const current = order.find((entry) => entry.slug === active) ?? order[0] ?? null;
  // 처리 결과로 줄이 빠지면 고른 것도 정리한다(없어진 slug 를 들고 있지 않게)
  const live = new Set(entries.map((entry) => entry.slug));
  const picked = [...selected].filter((slug) => live.has(slug));

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || order.length === 0) return;
      const index = Math.max(0, order.findIndex((entry) => entry.slug === current?.slug));
      if (event.key === "j") setActive(order[Math.min(order.length - 1, index + 1)].slug);
      else if (event.key === "k") setActive(order[Math.max(0, index - 1)].slug);
      else if (event.key === " " && current) {
        event.preventDefault();
        setSelected((now) => { const next = new Set(now); if (next.has(current.slug)) next.delete(current.slug); else next.add(current.slug); return next; });
      } else if (event.key === "x") detailRef.current?.confirmRemove();
      else if (event.key === "d") { event.preventDefault(); detailRef.current?.focusDismiss(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, current]);

  const toggle = (slug: string) => setSelected((now) => { const next = new Set(now); if (next.has(slug)) next.delete(slug); else next.add(slug); return next; });
  const allChecked = order.length > 0 && order.every((entry) => selected.has(entry.slug));
  const names = (slugs: string[]) => slugs.map((slug) => entries.find((entry) => entry.slug === slug)?.product?.name ?? slug);

  if (entries.length === 0) {
    return <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">기다리는 요청이 없습니다. 들어오면 메뉴의 &ldquo;내릴 후보&rdquo; 옆에 수가 붙습니다.</p>;
  }

  return (
    <div className="td-work">
      <section className="overflow-hidden rounded-[12px] border border-line bg-bg-card" aria-label="요청 목록">
        <div className="td-toolbar">
          <b>대기 {n(entries.length)}건</b>
          <span className="text-fg-3">묶기</span>
          <div className="td-seg" role="group" aria-label="묶기">
            {GROUPS.map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}
          </div>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="정렬" className="td-field">
            {Object.entries(SORTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·주소·사유·계정" aria-label="검색" className="td-field td-grow" />
        </div>

        <form ref={bulkFormRef} action={(form) => { bulkAction(form); setSelected(new Set()); }} className="td-bulk" aria-label="고른 요청 처리">
          {picked.map((slug) => <input key={slug} type="hidden" name="selected" value={slug} />)}
          <b>선택 {n(picked.length)}건</b>
          <button type="button" className="td-btn td-danger" disabled={picked.length === 0 || bulkPending} onClick={() => setConfirm(picked)}>선택 내린다</button>
          <select name="dismissReason" aria-label="두는 이유" className="td-field" defaultValue="test_spam">
            {Object.entries(DISMISS_REASONS).map(([value, label]) => <option key={value} value={value}>두는 이유 — {label}</option>)}
          </select>
          <button type="submit" name="action" value="dismiss" className="td-btn" disabled={picked.length === 0 || bulkPending}>선택 둔다</button>
          <span className="td-note td-push">{bulkPending ? "처리 중…" : "내리기는 이름을 한 번 훑는 확인을 거칩니다"}</span>
        </form>
        {/* 고른 것·묶음 전체 내리기 — 이름을 한 번 훑는 확인. 결과는 아래 줄(bulk)에 뜬다 */}
        <ConfirmAction open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}
          title={`${n(confirm?.length ?? 0)}건을 내립니다 — 이름을 한 번 훑어 주세요`} targets={names(confirm ?? [])}
          summary={<RemoveEffects />} confirmLabel={`${n(confirm?.length ?? 0)}건 내리기`}
          onConfirm={() => {
            // 전에 form 이 보내던 것과 같은 값 — 두는 이유 칸까지 실어 보낸다
            const form = new FormData(bulkFormRef.current ?? undefined);
            form.delete("selected");
            for (const slug of confirm ?? []) form.append("selected", slug);
            form.set("action", "remove");
            startTransition(() => bulkAction(form));
            setSelected(new Set());
          }} />
        <div aria-live="polite">
          {bulk?.error && <p className="td-msg text-down">{bulk.error}</p>}
          {typeof bulk?.done === "number" && <p className="td-msg"><b className="text-up">{n(bulk.done)}건 처리했습니다.</b>{bulk.failed?.length ? ` ${bulk.failed.length}건은 처리하지 못했습니다 — 이미 처리됐거나 제품이 없습니다.` : ""}</p>}
        </div>

        <ScrollTable label="요청 목록 표">
          <table className="td-table">
            <colgroup><col className="w-[34px]" /><col className="w-[28%]" /><col /><col className="w-[96px]" /><col className="w-[90px]" /><col className="w-[60px]" /><col className="w-[64px]" /></colgroup>
            <thead><tr>
              <th><input type="checkbox" aria-label="보이는 요청 모두 선택" checked={allChecked}
                onChange={() => setSelected(allChecked ? new Set() : new Set(order.map((entry) => entry.slug)))} /></th>
              <th>제품</th><th>요청 사유</th><th>보낸이</th><th className="r">기다림</th><th className="r">발행</th><th className="r">7일 방문</th>
            </tr></thead>
            <tbody>
              {groups.map((group) => (
                <GroupRows key={group.key} title={group.title} detail={group.detail} together={group.together} mode={mode}
                  entries={group.entries} selected={selected} current={current?.slug ?? null}
                  onPick={setActive} onToggle={toggle}
                  onRemoveAll={() => setConfirm(group.entries.map((entry) => entry.slug))}
                  onSelectAll={() => setSelected((now) => new Set([...now, ...group.entries.map((entry) => entry.slug)]))} />
              ))}
            </tbody>
          </table>
        </ScrollTable>
        <p className="td-foot">{n(order.length)}건 보임 · J/K 이동 · Space 선택 · X 내리기 확인 · D 둘 이유 고르기 · 줄을 누르면 오른쪽에 사유와 이력</p>
      </section>

      {current && <TakedownDetail key={current.slug} entry={current} handleRef={detailRef} />}
    </div>
  );
}

function GroupRows({ title, detail, together, mode, entries, selected, current, onPick, onToggle, onRemoveAll, onSelectAll }: {
  title: string; detail: string; together: boolean; mode: GroupMode; entries: TakedownEntry[]; selected: Set<string>; current: string | null;
  onPick: (slug: string) => void; onToggle: (slug: string) => void; onRemoveAll: () => void; onSelectAll: () => void;
}) {
  return (
    <>
      {title && (
        <tr className="td-group"><td colSpan={7}>
          <div className="td-row">
            <b>{title}</b><span className="text-fg-3">{detail}</span>
            {together && <>
              <button type="button" className="td-btn td-sm td-danger" onClick={onRemoveAll}>요청 {entries.length}건 모두 내린다</button>
              <button type="button" className="td-btn td-sm" onClick={onSelectAll}>모두 고르기</button>
              {mode === "owner" && entries[0].ownerPublic > entries.length && (
                <a href={`https://github.com/${entries[0].owner}`} target="_blank" rel="noreferrer noopener">이 계정의 나머지 공개 {n(entries[0].ownerPublic - entries.length)}개 — 자동으로 내리지 않습니다 ↗</a>
              )}
            </>}
          </div>
        </td></tr>
      )}
      {entries.map((entry) => {
        const tone = waitTone(entry.ageHours);
        return (
          <tr key={entry.slug} className="td-item" aria-selected={entry.slug === current} onClick={() => onPick(entry.slug)}>
            <td onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" aria-label={`${entry.product?.name ?? entry.slug} 선택`} checked={selected.has(entry.slug)} onChange={() => onToggle(entry.slug)} />
            </td>
            <td><span className="td-name"><b>{entry.product?.name ?? entry.slug}</b><span>{entry.product?.url.replace(/^https?:\/\//, "") ?? "제품 없음"}</span></span></td>
            <td><span className={`td-why ${entry.reason ? "" : "text-fg-3"}`}>{entry.reason ?? "사유 없음"}</span></td>
            {/* 칸이 좁아 해시 네 자리만 — 머리가 "보낸이"다. 같은 보낸이가 여럿이면 ×수 */}
            <td><span className="td-sender" title={`${senderLabel(entry.requesterHash)}${entry.senderPending > 1 ? ` · 대기 요청 ${entry.senderPending}건` : ""}`}>
              {entry.requesterHash ? entry.requesterHash.slice(0, 4) : "미상"}{entry.senderPending > 1 && <small> ×{entry.senderPending}</small>}</span></td>
            <td className="r"><span className="td-wait" data-tone={tone}>{formatWait(entry.ageHours)}</span></td>
            <td className="r font-mono">{day(entry.product?.listedAt ?? "")}</td>
            <td className="r font-mono">{n(entry.visits7d)}</td>
          </tr>
        );
      })}
    </>
  );
}

function RemoveEffects() {
  return <ul>{REMOVE_EFFECTS.map((line) => <li key={line}>{line}</li>)}</ul>;
}

/** 고른 한 건 — 사유·계정·보낸이·이력을 보고 내리거나 둔다. 내리기는 확인을 한 번 더 */
function TakedownDetail({ entry, handleRef }: { entry: TakedownEntry; handleRef: React.RefObject<{ confirmRemove: () => void; focusDismiss: () => void } | null> }) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(resolveTakedownRequest, null);
  const [confirming, setConfirming] = useState(false);
  const dismissRef = useRef<HTMLSelectElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useAdminToast();
  useEffect(() => {
    handleRef.current = { confirmRemove: () => entry.product && setConfirming(true), focusDismiss: () => dismissRef.current?.focus() };
    return () => { handleRef.current = null; };
  }, [handleRef, entry.product]);
  const product = entry.product;
  const outcome = entry.previousOutcome === "removed" ? "내림" : entry.previousOutcome === "dismissed" ? "둠" : null;
  return (
    <aside className="td-detail" aria-label="고른 요청">
      <div>
        <div className="td-row td-between"><h2>{product?.name ?? entry.slug}</h2><span className="td-wait" data-tone={waitTone(entry.ageHours)}>{formatWait(entry.ageHours)}</span></div>
        <div className="td-links">
          {product && <a href={product.url} target="_blank" rel="noreferrer noopener" className="font-mono">{product.url.replace(/^https?:\/\//, "")} ↗</a>}
          {product?.repoUrl && <a href={product.repoUrl} target="_blank" rel="noreferrer noopener" className="font-mono">{product.repoUrl.replace(/^https?:\/\/(www\.)?/, "")} ↗</a>}
          {product && <a href={`/p/${entry.slug}`} target="_blank" rel="noreferrer noopener">공개 페이지 ↗</a>}
        </div>
        <p className="td-facts">요청 {kst(entry.requestedAt)} · {senderLabel(entry.requesterHash)}{product ? ` · ${product.category}` : " · 제품이 이미 없습니다"}</p>
      </div>
      <div>
        <h3>요청 사유</h3>
        {entry.reason ? <p className="td-quote">{entry.reason}</p> : <p className="text-fg-3">사유 없음 — 이유 없이도 받습니다.</p>}
        <p className="td-note">요청자 연락처는 받지 않습니다 — 처리 결과는 페이지가 사라지는 것으로만 전해집니다.</p>
      </div>
      <dl className="td-kv">
        <dt>발행</dt><dd>{product?.listedAt ? product.listedAt.slice(0, 10) : "—"}{product?.stars ? ` · ★ ${n(product.stars)}` : ""}</dd>
        <dt>지난 7일</dt><dd>방문 {n(entry.visits7d)}</dd>
        <dt>이 제품</dt><dd>{entry.requestCount > 1 ? `${entry.requestCount}번째 요청` : "첫 요청"}{outcome ? ` · 전에 ${outcome}` : " · 전에 처리한 적 없음"}</dd>
        <dt>같은 계정</dt><dd>{entry.owner ? <><b>{entry.owner}</b> · 공개 {n(entry.ownerPublic)}개 · 대기 요청 {n(entry.ownerPending)}건</> : "GitHub 저장소 없음"}</dd>
        <dt>같은 보낸이</dt><dd>{entry.requesterHash ? `${senderLabel(entry.requesterHash)} · 대기 요청 ${n(entry.senderPending)}건` : "주소를 모름 — 묶을 수 없습니다"}</dd>
      </dl>
      <form ref={formRef} action={action} className="td-decide">
        <input type="hidden" name="slug" value={entry.slug} />
        <label><b>메모</b> <span className="text-fg-3">(선택 — 처리 기록에 남음)</span>
          <textarea name="note" maxLength={1000} rows={2} placeholder="예: 본인 요청 · 계정 전체 내림" /></label>
        <div className="td-row">
          <button type="button" className="td-btn td-danger" disabled={!product || pending} onClick={() => setConfirming(true)}>내린다</button>
          <select ref={dismissRef} name="dismissReason" aria-label="두는 이유" className="td-field" defaultValue="test_spam">
            {Object.entries(DISMISS_REASONS).map(([value, label]) => <option key={value} value={value}>둔다 — {label}</option>)}
          </select>
          <button type="submit" name="action" value="dismiss" disabled={pending} className="td-btn">둔다</button>
        </div>
        {/* 한 건 내리기 — 메모까지 이 form 의 값을 그대로 보낸다. 처리하는 동안 창이 "처리 중…"으로 기다리고, 실패하면 창에 사유가 뜬다 */}
        <ConfirmAction open={confirming} onOpenChange={setConfirming} title={`“${product?.name}”을 내립니다`}
          summary={<RemoveEffects />} confirmLabel="내리기"
          onConfirm={async () => {
            const form = new FormData(formRef.current ?? undefined);
            form.set("action", "remove");
            const result = await resolveTakedownRequest(null, form);
            if (!resultError(result)) toast.show({ message: `내림 · ${product?.name ?? entry.slug}`, link: { label: "기록 보기", href: "/admin/activity" } });
            return result;
          }} />
        {state?.error && <p role="status" className="text-down">{state.error}</p>}
      </form>
      {entry.owner && entry.ownerPublic > entry.ownerPending && (
        <div className="td-more">
          <h3>같은 계정 나머지</h3>
          <p className="text-fg-2">사유가 &ldquo;모두&rdquo;를 말해도 나머지 {n(entry.ownerPublic - entry.ownerPending)}개는 자동으로 내리지 않습니다 — 계정을 열어 보고 정합니다.</p>
          <a href={`https://github.com/${entry.owner}`} target="_blank" rel="noreferrer noopener">GitHub 계정 {entry.owner} ↗</a>
        </div>
      )}
    </aside>
  );
}
