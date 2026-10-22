import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";
import { contactLabels, contactStates } from "@/lib/operations/admin-requests-contract";
import { contactRequestQueue } from "@/lib/operations/contact-requests";
import { PageStamp } from "../components/PageStamp";
import { ContactCreateForm, ContactUpdateForm } from "./RequestForms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "문의 접수 — NoMoreVibe", robots: { index: false, follow: false } };
export default async function ContactRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin(); if (!admin) redirect("/admin/login");
  const secret = authSecret(); if (!secret) throw new Error("admin_auth_unconfigured");
  const params = await searchParams;
  const state = typeof params.state === "string" && (["open", "all", ...contactStates] as string[]).includes(params.state)
    ? params.state as "open" | "all" | typeof contactStates[number] : "open";
  const rawOffset = typeof params.offset === "string" ? Number(params.offset) : 0;
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;
  const queue = await contactRequestQueue({ state, offset });
  const csrf = { csrfToken: adminRequestToken("contact-requests", admin, secret), expiresAt: admin.exp };
  return <main className="space-y-5 p-5"><PageStamp /><h1 className="text-[22px] font-semibold">문의 접수</h1>
    <p>contact@nomorevibe.com으로 받은 메일을 관리자가 수동으로 기록하는 비공개 접수함입니다. 외부 메일함을 자동으로 읽거나 메일을 보내지 않습니다. 회신은 기존 메일함에서 보내고 처리 상태를 저장하세요.</p>
    <details className="rounded-xl border border-line p-4"><summary className="cursor-pointer">받은 메일 수동 접수</summary><ContactCreateForm {...csrf} /></details>
    <form action="/admin/requests" className="flex gap-3"><label>상태 <select name="state" defaultValue={state} className="min-h-11 rounded-lg border border-line px-3">
      <option value="open">열린 문의</option><option value="all">전체</option>{Object.entries(contactLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label><button className="min-h-11 rounded-lg border border-line px-4">조회</button></form>
    <p>문의 {queue.count.toLocaleString("ko-KR")}건 · 수신 시각이 오래된 것부터</p>
    {queue.items.map(item => <section key={`${item.id}-${item.version}`} id={`contact-${item.id}`} className="space-y-3 rounded-xl border border-line p-4">
      <h2 className="break-words text-lg font-semibold">{item.subject}</h2><p className="break-all text-sm">{item.senderEmail} · {item.receivedAt.toISOString()} · {contactLabels[item.status]}</p>
      <p className="whitespace-pre-wrap break-words">{item.body}</p><p className="text-sm text-fg-2">접수 {item.createdBy} · 최근 처리 {item.updatedBy} · {item.updatedAt.toISOString()}</p>
      <ContactUpdateForm {...csrf} id={item.id} version={item.version} status={item.status} handlingNote={item.handlingNote} />
    </section>)}
    {!queue.items.length && <p>조건에 맞는 문의가 없습니다.</p>}
    {queue.nextOffset !== null && <Link prefetch={false} href={`/admin/requests?state=${state}&offset=${queue.nextOffset}`} className="underline">다음 문의</Link>}
  </main>;
}
