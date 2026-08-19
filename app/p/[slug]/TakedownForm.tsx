"use client";

import { useState } from "react";

/**
 * 내려달라는 요청 폼.
 *
 * 상세 페이지가 "원치 않으시면 내려드립니다"라고 적어 두었으니 그 자리에 말할 곳이 있어야 한다.
 * 이유는 선택이다 — 이유를 대야 내려준다고 하면 약속이 조건부가 된다.
 */
export function TakedownForm({ slug }: { slug: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(form: FormData) {
    setState("sending");
    setError(null);
    try {
      const res = await fetch(`/api/products/${slug}/takedown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: String(form.get("reason") ?? "") }),
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
        요청을 받았습니다. 확인 후 내려드리겠습니다.
      </p>
    );
  }

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-[13px] font-semibold text-fg-2 hover:text-fg">
        목록에서 내려달라고 요청하기
      </summary>
      <form action={submit} className="mt-3 flex flex-col gap-2">
        <textarea
          name="reason"
          rows={2}
          maxLength={500}
          placeholder="이유를 적어주셔도 되고, 비워두셔도 됩니다"
          className="w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="self-start rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2 hover:text-fg disabled:opacity-50"
        >
          {state === "sending" ? "보내는 중…" : "요청 보내기"}
        </button>
        {error && <p className="text-[13px] text-down">{error}</p>}
      </form>
    </details>
  );
}
