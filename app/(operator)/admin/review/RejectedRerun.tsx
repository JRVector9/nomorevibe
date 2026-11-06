"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  continueRejectedRerunAction,
  prepareRejectedRerunAction,
  rerunSelectedRejectedAction,
} from "./rejected-rerun-actions";
import type { RejectedRerunSnapshot, RejectedRerunTarget } from "./rejected-rerun-contract";
import { MAX_BULK_DECISIONS } from "./contract";

const UNKNOWN = "응답 미확정: 자동 재전송하지 않았습니다. 새로고침해 처리 상태를 확인하세요.";
const PREPARE_FAILED = "재심사 준비를 읽지 못했습니다. 잠시 후 다시 시도하세요.";
const PREPARE_MALFORMED = "재심사 준비 응답을 확인하지 못했습니다.";
const FILTER_READ_FAILED = "적용할 필터 값을 읽지 못했습니다.";
const FILTER_KEYS = ["reason", "ai", "updated", "stage", "tab", "state", "q", "sort", "cause", "second"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isReasons(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isCount);
}

function isSnapshot(value: unknown): value is RejectedRerunSnapshot {
  if (!isRecord(value)) return false;
  const snapshot = value as Partial<RejectedRerunSnapshot>;
  const upperId = snapshot.upperId;
  const afterId = snapshot.afterId;
  const total = snapshot.total;
  const processed = snapshot.processed;
  const queued = snapshot.queued;
  const skipped = snapshot.skipped;
  return typeof snapshot.query === "string"
    && isId(upperId)
    && isId(afterId)
    && afterId <= upperId
    && typeof snapshot.startedAt === "string"
    && snapshot.startedAt.length > 0
    && isCount(total)
    && isCount(processed)
    && isCount(queued)
    && isCount(skipped)
    && processed === queued + skipped
    && (snapshot.skipReasons === undefined || isReasons(snapshot.skipReasons));
}

function sameScope(previous: RejectedRerunSnapshot, next: RejectedRerunSnapshot) {
  return previous.query === next.query
    && previous.upperId === next.upperId
    && previous.total === next.total
    && previous.startedAt === next.startedAt;
}

function mergeReasons(previous: Record<string, number>, incoming?: Record<string, number>) {
  if (!incoming) return previous;
  const next = { ...previous };
  for (const [reason, count] of Object.entries(incoming)) next[reason] = (next[reason] ?? 0) + count;
  return next;
}

function readFilterQuery(form: HTMLFormElement): string | null {
  let data: FormData;
  try {
    data = new FormData(form);
  } catch {
    return null;
  }
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const values = data.getAll(key);
    if (values.length === 0) continue;
    if (values.length !== 1) return null;
    const value = values[0];
    if (typeof value !== "string") return null;
    params.set(key, value);
  }
  return params.toString();
}

export function RejectedRerun({ query, targets }: { query?: string; targets?: RejectedRerunTarget[] }) {
  const filterMode = query !== undefined;
  const [running, setRunning] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RejectedRerunSnapshot | null>(null);
  const [initialTotal, setInitialTotal] = useState<number | null>(null);
  const [selectedTotal, setSelectedTotal] = useState<number | null>(null);
  const [counts, setCounts] = useState({ queued: 0, skipped: 0 });
  const [reasons, setReasons] = useState<Record<string, number>>({});
  const [completed, setCompleted] = useState(false);
  const [stopped, setStopped] = useState(false);
  const busy = useRef(false);
  const stop = useRef(false);
  const mounted = useRef(true);
  const targetCount = targets?.length ?? 0;

  useEffect(() => {
    mounted.current = true;
    stop.current = false;
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, []);

  function failUnknown() {
    if (!mounted.current) return;
    setError(UNKNOWN);
    setBlocked(true);
  }

  async function runFilter(event: MouseEvent<HTMLButtonElement>) {
    if (query === undefined || blocked || busy.current) return;
    const form = event.currentTarget.closest("form") as HTMLFormElement | null;
    let derivedQuery: string;
    if (form) {
      const value = readFilterQuery(form);
      if (value === null) {
        if (mounted.current) setError(FILTER_READ_FAILED);
        return;
      }
      derivedQuery = value;
    } else {
      derivedQuery = query;
    }
    busy.current = true;
    stop.current = false;
    if (mounted.current) {
      setRunning(true);
      setError(null);
      setNotice(null);
      setCompleted(false);
      setStopped(false);
      setSnapshot(null);
      setInitialTotal(null);
      setCounts({ queued: 0, skipped: 0 });
      setReasons({});
    }
    try {
      let prepared: unknown;
      try {
        const data = new FormData();
        data.set("query", derivedQuery);
        prepared = await prepareRejectedRerunAction(data);
      } catch {
        if (mounted.current) setError(PREPARE_FAILED);
        return;
      }
      if (!mounted.current || stop.current) return;
      if (!isRecord(prepared)) {
        setError(PREPARE_MALFORMED);
        return;
      }
      const prepareError = prepared.error;
      if (prepareError !== undefined) {
        if (typeof prepareError !== "string") {
          setError(PREPARE_MALFORMED);
          return;
        }
        setError(prepareError || PREPARE_FAILED);
        return;
      }
      const initial = prepared.snapshot;
      if (!isSnapshot(initial)) {
        setError(PREPARE_MALFORMED);
        return;
      }
      if (initial.afterId !== 0 || initial.processed !== 0 || initial.queued !== 0 || initial.skipped !== 0) {
        setError(PREPARE_MALFORMED);
        return;
      }
      setSnapshot(initial);
      setInitialTotal(initial.total);
      setCounts({ queued: initial.queued, skipped: initial.skipped });
      setReasons(initial.skipReasons ?? {});
      if (initial.total === 0) {
        setNotice("재심사할 반려 후보가 없습니다.");
        return;
      }
      if (!window.confirm(`지금 고른 조건의 반려 후보 ${initial.total.toLocaleString("ko-KR")}건의 AI 1차 재심사를 접수할까요?`)) return;
      let current = initial;
      while (mounted.current) {
        if (stop.current) {
          setStopped(true);
          break;
        }
        let response: unknown;
        try {
          response = await continueRejectedRerunAction(current);
        } catch {
          failUnknown();
          return;
        }
        if (!mounted.current) return;
        if (!isRecord(response)) {
          failUnknown();
          return;
        }
        if (response.error !== undefined) {
          failUnknown();
          return;
        }
        if (response.done !== undefined && typeof response.done !== "boolean") {
          failUnknown();
          return;
        }
        const next = response.snapshot;
        if (!isSnapshot(next) || !sameScope(current, next)) {
          failUnknown();
          return;
        }
        const done = response.done === true;
        if (next.afterId < current.afterId
          || next.processed < current.processed
          || next.queued < current.queued
          || next.skipped < current.skipped) {
          failUnknown();
          return;
        }
        if (!done && next.afterId <= current.afterId) {
          failUnknown();
          return;
        }
        current = next;
        setSnapshot(next);
        setCounts({ queued: next.queued, skipped: next.skipped });
        setReasons(next.skipReasons ?? {});
        if (done) {
          setCompleted(true);
          break;
        }
      }
    } finally {
      busy.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  async function runSelection() {
    if (blocked || busy.current || !targets || targets.length === 0) return;
    const copied = targets.map(target => ({ ...target }));
    busy.current = true;
    stop.current = false;
    if (mounted.current) {
      setRunning(true);
      setError(null);
      setNotice(null);
      setCompleted(false);
      setStopped(false);
      setSnapshot(null);
      setInitialTotal(null);
      setSelectedTotal(copied.length);
      setCounts({ queued: 0, skipped: 0 });
      setReasons({});
    }
    try {
      if (!window.confirm(`선택한 반려 후보 ${copied.length.toLocaleString("ko-KR")}건의 AI 1차 재심사를 접수할까요?`)) return;
      let sentAll = true;
      for (let index = 0; index < copied.length; index += MAX_BULK_DECISIONS) {
        if (!mounted.current) return;
        if (stop.current) {
          sentAll = false;
          setStopped(true);
          break;
        }
        const batch = copied.slice(index, index + MAX_BULK_DECISIONS);
        let response: unknown;
        try {
          response = await rerunSelectedRejectedAction(batch);
        } catch {
          failUnknown();
          return;
        }
        if (!mounted.current) return;
        if (!isRecord(response)) {
          failUnknown();
          return;
        }
        if (response.error !== undefined) {
          failUnknown();
          return;
        }
        const queued = response.queued;
        const skipped = response.skipped;
        if (!isCount(queued) || !isCount(skipped) || queued + skipped !== batch.length) {
          failUnknown();
          return;
        }
        const skipReasons = response.skipReasons;
        if (skipReasons !== undefined && !isReasons(skipReasons)) {
          failUnknown();
          return;
        }
        setCounts(previous => ({ queued: previous.queued + queued, skipped: previous.skipped + skipped }));
        if (skipReasons) setReasons(previous => mergeReasons(previous, skipReasons));
      }
      if (!mounted.current) return;
      if (sentAll) setCompleted(true);
    } finally {
      busy.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  return (
    <div data-dirty={running || undefined}>
      {filterMode ? (
        <>
          <button type="button" className="text-button" disabled={running || blocked} onClick={event => { void runFilter(event); }}>
            필터 전체 AI 1차 재심사
          </button>
          <p className="table-note">지금 고른 조건의 반려 전체 · 아직 불러오지 않은 후보 포함.</p>
        </>
      ) : (
        <button type="button" className="text-button" disabled={running || blocked || targetCount === 0} onClick={() => { void runSelection(); }}>
          선택 반려 AI 1차 재심사
        </button>
      )}
      {running && (
        <button type="button" className="text-button" onClick={() => { stop.current = true; }}>
          다음 묶음부터 중단
        </button>
      )}
      {error && <p className="table-note" role="alert">{error}</p>}
      {notice && <p className="table-note">{notice}</p>}
      {filterMode && initialTotal !== null && (
        <p className="table-note">
          초기 기준 약 {initialTotal.toLocaleString("ko-KR")}건
          {snapshot && snapshot.total !== initialTotal ? ` · 현재 기준 ${snapshot.total.toLocaleString("ko-KR")}건` : ""}
          {" · "}처리 {snapshot?.processed ?? 0}건 · 요청 등록 {snapshot?.queued ?? counts.queued}건 · 제외 {snapshot?.skipped ?? counts.skipped}건
        </p>
      )}
      {!filterMode && selectedTotal !== null && (
        <p className="table-note">대상 {selectedTotal.toLocaleString("ko-KR")}건 · 요청 등록 {counts.queued}건 · 제외 {counts.skipped}건</p>
      )}
      {Object.entries(reasons).length > 0 && (
        <p className="table-note">
          제외 사유: {Object.entries(reasons).map(([reason, count]) => `${reason} ${count}건`).join(" · ")}
        </p>
      )}
      {completed && <p className="table-note">요청 등록 절차를 마쳤습니다.</p>}
      {stopped && <p className="table-note">다음 묶음부터 중단했습니다. 이미 등록된 요청은 계속 처리됩니다.</p>}
      {(running || completed || stopped) && <p className="table-note">등록한 후보는 기존 작업자가 심사합니다. 규칙·근거·모델 한도는 그대로 확인합니다.</p>}
    </div>
  );
}
