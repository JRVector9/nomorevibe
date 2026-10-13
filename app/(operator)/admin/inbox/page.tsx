import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { loadInbox } from "@/lib/operations/inbox";
import { assembleInbox } from "./inbox-model";
import { InboxCard } from "./InboxCard";
import "./inbox.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "오늘 할 일 — NoMoreVibe", robots: { index: false } };

const count = (value: number) => value.toLocaleString("ko-KR");

/**
 * 오늘 할 일(2026-10-08 UX 감사 ADM-07) — 운영자 한 명이 "오늘 무엇을 어떤 차례로 처리하나"에 답한다.
 * 심사·감사·응답 없음·소개 확인처럼 따로 쌓이던 일을 한 화면에 모으고, 칸마다 처리하는 화면으로 보낸다.
 * 여기서는 아무것도 바꾸지 않는다.
 */
export default async function AdminInboxPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const snapshot = await loadInbox();
  const inbox = assembleInbox(snapshot.results, snapshot.done);
  const now = snapshot.fetchedAt;

  return (
    <main className="flex flex-col gap-3 pb-10 pt-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-3">
        <h1 className="text-[22px] font-extrabold tracking-tight">오늘 할 일</h1>
        <p className="text-[14px] font-semibold text-fg-2"
          title="처리는 최근 24시간에 사람이 내린 심사 결정과 내려달라는 요청 처리를 더한 수, 남은 일은 아래 칸의 수를 더한 것">
          오늘 처리 <span className="font-mono">{inbox.done === null ? "?" : count(inbox.done)}</span>건
          {" · "}남은 일 <span className="font-mono">{count(inbox.remaining)}</span>건{inbox.failed > 0 && " 이상"}
        </p>
        <p className="w-full text-[13px] text-fg-3">
          사람이 처리할 것을 급한 차례대로 모았습니다. 수는 각 처리 화면과 같고, 줄은 오래 기다린 것부터입니다.
          {" "}{formatListTime(now, now)} 기준.
        </p>
      </div>

      {inbox.failed > 0 && (
        <p role="status" className="text-[13px] text-fg-2">
          {count(inbox.failed)}개 칸을 불러오지 못했습니다 — 남은 일은 그만큼 더 있을 수 있습니다.
        </p>
      )}

      {inbox.sections.length === 0 ? (
        <p className="rounded-[12px] border border-line bg-bg-card px-5 py-10 text-center text-[15px] font-semibold text-fg-2">
          오늘 할 일이 없습니다.
        </p>
      ) : (
        inbox.sections.map((section) => <InboxCard key={section.key} section={section} now={now} />)
      )}

      {inbox.clear.length > 0 && (
        <p className="text-[13px] text-fg-3">
          <span className="font-semibold text-fg-2">할 일 없음</span>{" — "}
          {inbox.clear.map((section, index) => (
            <span key={section.key}>
              {index > 0 && " · "}
              <Link href={section.href} className="underline">{section.title}</Link>
            </span>
          ))}
        </p>
      )}
    </main>
  );
}
