"use client";

import Link from "next/link";
import { useState } from "react";
import { TAKEDOWN_KINDS, TAKEDOWN_PROMISE, TAKEDOWN_RECEIVED, type TakedownKind } from "@/lib/domain/products/takedown-view";

/** 갈래마다 한 줄 설명과 이유 칸 안내 */
const KIND_COPY: Record<TakedownKind, { hint: string; placeholder: string }> = {
  owner: { hint: "운영자가 목록에서 빼 달라는 요청", placeholder: "이슈·파일 주소나 이유를 적어 주세요. 비워 두셔도 됩니다" },
  abuse: { hint: "스팸이거나 악성 코드·사기로 이어지는 프로젝트", placeholder: "무엇이 문제인지 적어 주시면 더 빨리 확인합니다. 비워 두셔도 됩니다" },
};
const KINDS = Object.keys(TAKEDOWN_KINDS) as TakedownKind[];

/**
 * 내려달라는 요청 폼.
 *
 * 상세 페이지가 "원치 않으시면 내려드립니다"라고 적어 두었으니 그 자리에 말할 곳이 있어야 한다.
 * 이유는 선택이다 — 이유를 대야 내려준다고 하면 약속이 조건부가 된다.
 *
 * 운영자의 요청과 스팸·악성 신고를 고르게 하고(사유 앞에 갈래가 붙는다 — takedown-view.ts), 처리 약속(24시간 안 확인,
 * 확인 전 검색엔진 노출 중지)과 운영자임을 보이는 방법(저장소 이슈·파일)을 함께 적는다(UX-19). 연락처는 받지 않는다(D5).
 */
export function TakedownForm({ slug }: { slug: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<TakedownKind>("owner");

  async function submit(form: FormData) {
    setState("sending");
    setError(null);
    try {
      const res = await fetch(`/api/products/${slug}/takedown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: String(form.get("reason") ?? ""), kind }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "요청을 보내지 못했습니다");
        setState("idle");
        return;
      }
      setState("sent");
    } catch {
      setError("요청을 보내지 못했습니다. 잠시 후 다시 시도해주세요.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <p className="mt-4 rounded-[10px] border border-up/40 bg-up/10 px-4 py-3 text-[13px] text-up">
        {TAKEDOWN_RECEIVED}
      </p>
    );
  }

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-[13px] font-semibold text-fg-2 hover:text-fg">
        목록에서 내려달라고 요청하기
      </summary>
      <form action={submit} className="mt-3 flex flex-col gap-2">
        <fieldset className="m-0 flex flex-col border-0 p-0">
          <legend className="mb-1 text-[13px] font-semibold text-fg">어떤 요청인가요?</legend>
          {KINDS.map((value) => (
            <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] leading-5 text-fg">
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)}
                className="h-4 w-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
              <span>{TAKEDOWN_KINDS[value]} <span className="text-fg-2">· {KIND_COPY[value].hint}</span></span>
            </label>
          ))}
        </fieldset>
        {kind === "owner" && (
          <p className="m-0 text-[13px] leading-5 text-fg-2">
            운영자임을 빨리 확인할 수 있게, 저장소에 이 요청을 적은 이슈를 열거나 저장소에 파일을 하나 더한 뒤 그 주소를 아래 칸에 적어 주세요.
          </p>
        )}
        <textarea
          name="reason"
          rows={2}
          maxLength={500}
          aria-label="요청 이유"
          placeholder={KIND_COPY[kind].placeholder}
          className="w-full rounded-[10px] border border-line bg-bg-soft px-3 py-2 text-[13px] text-fg outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <p className="m-0 text-[13px] leading-5 text-fg-2">
          {TAKEDOWN_PROMISE}{" "}
          <Link prefetch={false} href="/policy#takedown" className="text-accent-ink hover:underline">처리 절차 보기</Link>
        </p>
        <button
          type="submit"
          disabled={state === "sending"}
          className="min-h-11 self-start rounded-[10px] border border-line px-4 text-[13px] font-semibold text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {state === "sending" ? "보내는 중…" : "요청 보내기"}
        </button>
        {error && <p className="text-[13px] text-down">{error}</p>}
      </form>
    </details>
  );
}
