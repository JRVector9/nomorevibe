"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * 관리자 알림(2026-10-08 UX 감사 ADM-12) — 결정·차단·내리기 뒤에 "승인함 · auto-claude-skills · 되돌리기(10초) · 기록 보기"를 띄운다.
 *
 * AdminShell 이 AdminToastProvider 를 한 번 감싸고, 알림 자리(aria-live)는 그 안에 늘 놓여 있다.
 * 화면은 useAdminToast().show({...}) 만 부른다. 서버 액션 결과는 resultToast 로 바꿔 넘긴다:
 *
 *   const toast = useAdminToast();
 *   const [state, action] = useActionState(async (prev: ReviewState, form: FormData) => {
 *     const result = await decideCrawlCandidate(prev, form);
 *     toast.show(resultToast(result, { message: `승인함 · ${name}`, link: { label: "기록 보기", href: "/admin/activity" } }));
 *     return result;
 *   }, null);
 */

export type ToastTone = "ok" | "warn" | "error";

/** 되돌리기 — run 이 끝나면 알림이 결과(되돌림/실패 사유)로 바뀐다. 실패는 resultError 와 같은 규칙으로 읽는다 */
export type ToastUndo = {
  run: () => unknown;
  /** 기본 "되돌리기" */
  label?: string;
  /** 되돌리기를 내미는 시간 — 기본 10초. 지나면 알림이 사라진다 */
  ms?: number;
};

export type ToastInput = {
  message: string;
  /** 기본 ok */
  tone?: ToastTone;
  /** "기록 보기" 같은 이동 */
  link?: { label: string; href: string };
  undo?: ToastUndo;
  /** 자동으로 닫히기까지 — 기본 6초(되돌리기가 있으면 그 시간). 마우스나 포커스가 알림 위에 있으면 멈춘다 */
  ms?: number;
};

export type AdminToast = { show: (input: ToastInput) => number; dismiss: (id: number) => void };

/** 한 번에 보이는 알림 수 — 넘치면 오래된 것부터 닫는다 */
const MAX_TOASTS = 3;
const DEFAULT_MS = 6_000;
const UNDO_MS = 10_000;

type Item = ToastInput & { id: number; undoing?: boolean };

const NOOP: AdminToast = { show: () => -1, dismiss: () => {} };
const ToastContext = createContext<AdminToast>(NOOP);

/** 알림을 띄우는 손잡이. AdminToastProvider 밖(로그인 화면·단위 테스트)에서는 아무것도 하지 않는다 */
export function useAdminToast(): AdminToast {
  return useContext(ToastContext);
}

/** 서버 액션 결과·되돌리기 결과에서 실패 사유를 꺼낸다. 성공(null·undefined·{ok}·{message})이면 null */
export function resultError(result: unknown): string | null {
  if (typeof result === "string") return result || null;
  if (!result || typeof result !== "object") return null;
  const { error, issues } = result as { error?: unknown; issues?: unknown };
  if (typeof error === "string" && error) return error;
  if (Array.isArray(issues) && issues.length > 0) return issues.join(" · ");
  return null;
}

/** 이 저장소 서버 액션들이 돌려주는 모양 — null(성공), {error}, {issues}, {message}, 일괄의 {failed}·{failures} */
export type ActionResultLike = {
  error?: string; issues?: string[]; message?: string; failed?: readonly unknown[]; failures?: readonly unknown[];
} | null | undefined | void;

/**
 * 서버 액션 결과를 알림으로. 실패면 error 톤에 사유, 일괄에서 일부만 실패하면 warn 톤에 "N건 실패"를 붙이고 되돌리기는 뺀다.
 * success 를 비우면 액션이 준 message(없으면 "처리했습니다")를 쓴다.
 */
export function resultToast(result: ActionResultLike, success?: string | ToastInput): ToastInput {
  const error = resultError(result);
  if (error) return { message: error, tone: "error" };
  const base: ToastInput = typeof success === "string" ? { message: success } : success ?? { message: result?.message || "처리했습니다" };
  const failed = (result?.failed?.length ?? 0) + (result?.failures?.length ?? 0);
  if (failed > 0) return { ...base, message: `${base.message} · ${failed.toLocaleString("ko-KR")}건 실패`, tone: "warn", undo: undefined };
  return { tone: "ok", ...base };
}

export function AdminToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((now) => now.filter((item) => item.id !== id)), []);
  const show = useCallback((input: ToastInput) => {
    const id = next.current++;
    setItems((now) => [...now, { ...input, id }].slice(-MAX_TOASTS));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  const undo = useCallback(async (item: Item) => {
    if (!item.undo) return;
    setItems((now) => now.map((one) => one.id === item.id ? { ...one, undoing: true } : one));
    let error: string | null;
    try {
      error = resultError(await item.undo.run());
    } catch {
      error = "되돌리지 못했습니다 — 잠시 뒤 다시 해 주세요";
    }
    // 결과로 바꾸면서 되돌리기는 거둔다. 새 시간(기본 6초)으로 다시 센다
    setItems((now) => now.map((one) => one.id !== item.id ? one : {
      id: next.current++, message: error ? `되돌리지 못했습니다 — ${error}` : "되돌렸습니다", tone: error ? "error" : "ok", link: one.link,
    }));
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className="admin-toasts" aria-label="알림" aria-live="polite">
        {items.map((item) => <ToastCard key={item.id} item={item} onDismiss={dismiss} onUndo={undo} />)}
      </section>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss, onUndo }: { item: Item; onDismiss: (id: number) => void; onUndo: (item: Item) => void }) {
  const [paused, setPaused] = useState(false);
  const life = item.ms ?? (item.undo ? item.undo.ms ?? UNDO_MS : DEFAULT_MS);
  // 남은 시간 — 멈췄다 풀리면 남은 만큼만 다시 센다
  const left = useRef(life);
  useEffect(() => {
    if (paused || item.undoing) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(item.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(1_000, left.current - (Date.now() - started));
    };
  }, [paused, item.undoing, item.id, onDismiss]);

  const seconds = Math.round((item.undo?.ms ?? UNDO_MS) / 1000);
  return (
    <div className="admin-toast" data-tone={item.tone ?? "ok"}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
      <span className="admin-toast-message">{item.message}</span>
      {item.undo && <button type="button" className="admin-toast-undo" disabled={item.undoing} onClick={() => onUndo(item)}>
        {item.undoing ? "되돌리는 중…" : `${item.undo.label ?? "되돌리기"} (${seconds}초)`}
      </button>}
      {item.link && <Link href={item.link.href} prefetch={false}>{item.link.label}</Link>}
      <button type="button" className="admin-toast-close" aria-label="알림 닫기" onClick={() => onDismiss(item.id)}>✕</button>
    </div>
  );
}
