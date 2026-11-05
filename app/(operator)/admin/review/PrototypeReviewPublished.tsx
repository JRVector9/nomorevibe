"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import type { PublishedSecondRow } from "./PublishedSecondReviews";
import { resolvePublishedSecondReview } from "./actions";
import { ReasonText } from "./ReasonText";
import { ConfirmAction } from "../components/ConfirmAction";
import { AsyncScrollBoundary } from "../components/AsyncScrollBoundary";

export function PrototypeReviewPublished({ rows: initialRows, total = initialRows.length, nextCursor = null, q = "" }: {
  rows: PublishedSecondRow[]; total?: number; nextCursor?: string | null; q?: string;
}) {
  const [page, setPage] = useState({ initial: initialRows, query: q, rows: initialRows, cursor: nextCursor });
  const rows = page.initial === initialRows && page.query === q ? page.rows : initialRows;
  const cursor = page.initial === initialRows && page.query === q ? page.cursor : nextCursor;
  const [id, setId] = useState(initialRows[0]?.id ?? 0), selected = rows.find(row => row.id === id);
  const [pendingFor, setPendingFor] = useState<{ initial: PublishedSecondRow[]; query: string } | null>(null);
  const [failed, setFailed] = useState<{ initial: PublishedSecondRow[]; query: string; message: string } | null>(null);
  const loading = pendingFor?.initial === initialRows && pendingFor.query === q, error = failed?.initial === initialRows && failed.query === q ? failed.message : null;
  const request = useRef<AbortController | null>(null), busy = useRef(false);
  useEffect(() => () => { request.current?.abort(); request.current = null; busy.current = false; }, [initialRows, q]);
  async function loadMore() {
    if (busy.current || !cursor) return;
    busy.current = true;
    const controller = new AbortController(); request.current = controller;
    setPendingFor({ initial: initialRows, query: q }); setFailed(null);
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    try {
      const response = await fetch(`/admin/review/published-scroll?${new URLSearchParams({ cursor, q })}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("다음 공개분을 읽지 못했습니다. 로그인 상태를 확인하고 다시 시도하세요.");
      const data = await response.json();
      if (!Array.isArray(data.rows) || data.rows.length > 30 || data.rows.some((row: PublishedSecondRow) => !Number.isSafeInteger(row.id) || row.id <= 0)
        || (data.nextCursor !== null && typeof data.nextCursor !== "string") || data.nextCursor === cursor)
        throw new Error("목록 응답을 확인하지 못했습니다. 새로고침해 다시 확인하세요.");
      if (controller.signal.aborted) return;
      setPage(previous => {
        const all = new Map((previous.initial === initialRows && previous.query === q ? previous.rows : initialRows).map(row => [row.id, row]));
        for (const row of data.rows as PublishedSecondRow[]) all.set(row.id, row);
        return { initial: initialRows, query: q, rows: [...all.values()], cursor: data.nextCursor };
      });
    } catch (failure) {
      if (!controller.signal.aborted || timedOut) setFailed({ initial: initialRows, query: q,
        message: timedOut ? "다음 공개분 응답이 늦어졌습니다. 다시 시도하세요." : failure instanceof Error ? failure.message : "다음 공개분을 읽지 못했습니다." });
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) { request.current = null; busy.current = false; setPendingFor(null); }
    }
  }
  return <div id="review-list" className="grid detail" data-admin-scroll-active={loading || rows.length > 30 || undefined}>
    <section className="panel"><div className="panel-head"><h3>공개 후 다시 확인할 프로젝트</h3><span className="tag gray">전체 {total.toLocaleString("ko-KR")}건</span></div>
      <p className="table-note">추가 자동 의견의 반려·보류 우선 · 같은 그룹은 최근 검토 순 · 처음 30개</p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="공개분 2차 확인"><table style={{ minWidth: 570 }}><thead><tr><th>프로젝트·저장소</th><th>확인 사유</th><th>AI 판단</th><th>다음 행동</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={row.id === id ? "selected" : undefined}><td><button className="text-button name" onClick={() => setId(row.id)}>{row.slug || row.repo}</button><p>{row.repo}</p></td><td>{row.trigger === "risk" ? "위험 신호" : row.trigger === "sample" ? "표본 재확인" : row.trigger}</td><td><span className="tag amber">2차 {row.decision === "reject" ? "반려 의견" : "판단 보류"}</span><p>확신 {row.confidence?.toFixed(2) ?? "—"}</p></td><td><button className="button small" onClick={() => setId(row.id)}>공개 유지 검토</button></td></tr>)}</tbody></table>
      <AsyncScrollBoundary hasMore={!!cursor} loading={loading} error={error} onLoad={() => { void loadMore(); }} />
      </div>
      {!rows.length && <div className="empty"><b>사람이 확인할 공개분이 없습니다.</b></div>}
      <p className="table-note">불러온 {rows.length.toLocaleString("ko-KR")}건 · 이미 공개된 프로젝트입니다. 후보 반려와 구분해 공개 중단·유지를 결정합니다.</p>
      {rows.length > 30 && <p className="table-note">추가 목록을 확인하는 동안 자동 갱신은 잠시 쉽니다. 새로고침하면 처음 30개부터 다시 확인합니다.</p>}
    </section><section className="panel pad sticky-detail">{selected ? <PublishedDetail key={selected.id} row={selected} /> : <div className="empty"><b>{id ? "선택한 공개분이 목록에서 빠졌습니다." : "프로젝트를 선택하세요."}</b></div>}</section>
  </div>;
}
function PublishedDetail({ row }: { row: PublishedSecondRow }) {
  const [state, action, pending] = useActionState(resolvePublishedSecondReview, null), [confirm, setConfirm] = useState(false), [result, setResult] = useState("");
  return <div className="stack"><div className="detail-header"><div><div className="eyebrow">공개분 재확인 #{row.id}</div><h2>{row.slug || row.repo}</h2><p>{row.repo}</p></div><span className="tag green">현재 공개</span></div><div className="evidence-box"><b>공개 후 2차 판단 근거</b><p><ReasonText text={row.reason} korean={row.reasonKo} /></p></div>
    <div className="vote-grid"><div className="vote"><span className="small muted">공개 후 2차</span><b>{row.decision === "reject" ? "반려 의견" : "판단 보류"}</b><span className="tag gray">확신 {row.confidence?.toFixed(2) ?? "—"}</span></div><div className="vote"><span className="small muted">추가 자동 의견</span><b>{row.qwen?.decision === "reject" ? "반려 의견" : row.qwen?.decision === "needs_review" ? "판단 보류" : row.qwen?.decision === "approve" ? "유지 의견" : "기록 —"}</b><p>확신 {row.qwen?.confidence?.toFixed(2) ?? "—"}</p></div></div>
    <dl className="facts"><dt>확인 계기</dt><dd>{row.trigger === "risk" ? "위험 신호" : row.trigger === "sample" ? "표본 재확인" : row.trigger}</dd><dt>다음 단계</dt><dd>공개 중단 또는 현재 공개 유지</dd><dt>현재 프로젝트</dt><dd>{row.slug ? <a className="text-button" href={`/admin/products/${row.slug}`}>프로젝트 상세</a> : "—"}</dd></dl>
    <details className="panel"><summary>신호·추가 판단 근거</summary><div className="panel-body"><p className="small">{row.signals.join(" · ") || "저장된 신호 —"}</p>{row.qwen?.reason && <div className="evidence-box"><ReasonText text={row.qwen.reason} korean={row.qwen.reasonKo} /></div>}</div></details>
    <form action={action}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="slug" value={row.slug} /><div className="decision-bar"><button className="button primary" name="decision" value="keep" disabled={pending || !row.slug}>현재 공개 유지</button><button className="button danger" type="button" disabled={pending || !row.slug} onClick={() => setConfirm(true)}>공개 중단</button></div></form>
    <ConfirmAction open={confirm} onOpenChange={setConfirm} title={`“${row.slug}” 공개를 중단합니다`} tone="danger" targets={[row.slug]} summary={<p>공개 목록과 상세에서 내려가고 재수집이 차단됩니다. 원본 프로젝트와 감사 기록은 유지합니다.</p>} confirmLabel="공개 중단" onConfirm={async () => { const form = new FormData(); form.set("id", String(row.id)); form.set("slug", row.slug); form.set("decision", "ban"); const response = await resolvePublishedSecondReview(null, form); if (response?.error) return { error: response.error }; setResult(response?.message ?? "처리 결과를 확인했습니다."); return null; }} />
    {(state || result) && <p role="status" className={state?.error ? "error" : "small"}>{state?.error ?? state?.message ?? result}</p>}<p className="small muted">공개 중단·유지는 원본 상태를 다시 검사한 뒤 처리 기록을 남깁니다.</p>
  </div>;
}
