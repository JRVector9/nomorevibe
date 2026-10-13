import { createHmac } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { productTranslationAdminQueue, productTranslationAdminSummary } from "@/lib/domain/products/translation-admin";
import { isProductTranslationField, PRODUCT_TRANSLATION_MAX_ATTEMPTS } from "@/lib/domain/products/translation-policy";
import type { ProductTranslationLocale, ProductTranslationStatus } from "@/lib/db/schema";
import { formatDetailTime } from "@/lib/format/time";
import { TranslationRetryForm } from "./TranslationRetryForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 번역 — NoMoreVibe", robots: { index: false, follow: false } };
const LOCALES = { en: "영어", "zh-Hans": "중국어 간체", "zh-Hant": "중국어 번체" };
const FIELDS = { tagline: "한 줄 소개", description: "설명" };
const STATES = { failed: "실패", pending: "자동 처리 대기", ready: "번역 저장됨", reviewed: "검토값 저장됨", all: "전체" };
const REASONS: Record<string, string> = {
  product_not_public: "현재 제품이 공개 상태가 아닙니다.", takedown_pending: "내림 요청 처리 대기 중입니다.",
  intro_editor_hold: "현재 원문이 소개 편집 보류 상태입니다.", ineligible: "현재 번역 대상이 아닙니다.",
  empty_source: "현재 원문이 비어 있어 번역이 필요하지 않습니다.", source_native: "현재 원문이 대상 언어로 확인돼 번역이 필요하지 않습니다.",
  source_too_long: "원문이 4,000자를 넘습니다. 같은 원문으로 재시도하지 않습니다.", exhausted: "같은 원문의 자동 4회 상한을 소진했습니다.",
  retry_wait: "기존 재시도 시간을 기다립니다.", new_source: "저장된 번역의 원문이 바뀌었습니다. 현재 원문만 새로 접수할 수 있습니다.",
  retry: "기존 시도 횟수와 재시도 시간을 유지해 한 건 접수할 수 있습니다.", not_failed: "자동 처리 대기 또는 저장된 값입니다. 실패값만 재요청합니다.",
};

export default async function AdminTranslationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const secret = authSecret();
  if (!secret) throw new Error("admin_auth_unconfigured");
  const csrfToken = createHmac("sha256", secret).update(`product-translation-admin:${admin.login}:${admin.exp}`).digest("hex");
  const params = await searchParams;
  const state = typeof params.state === "string" && Object.hasOwn(STATES, params.state) ? params.state as ProductTranslationStatus | "all" : "failed";
  const locale = typeof params.locale === "string" && Object.hasOwn(LOCALES, params.locale) ? params.locale as ProductTranslationLocale : undefined;
  const field = isProductTranslationField(params.field) ? params.field : undefined;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 120) : "";
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const [queue, summary] = await Promise.all([productTranslationAdminQueue({ state, locale, field, q, cursor }), productTranslationAdminSummary()]);
  const next = new URLSearchParams({ state, q });
  if (locale) next.set("locale", locale);
  if (field) next.set("field", field);
  if (queue.nextCursor) next.set("cursor", queue.nextCursor);
  return <main className="mx-auto max-w-5xl space-y-5 p-5">
    <h1 className="text-[22px] font-semibold">제품 번역</h1>
    <p className="text-[14px] leading-6 text-fg-2">공개 제품의 언어별 수요 기록입니다. 한국어 심사 사유 번역과 별개이며, 중단된 소개 검수를 재개하지 않습니다. 모델 호출은 기존 text 워커만 수행합니다.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-[13px]">
      <caption className="pb-2 text-left text-fg-2">저장 상태 집계입니다. 현재 공개 준비 여부는 아래 원문 일치·보류 상태를 함께 확인하세요. 소진·재시도 대기는 실패 건수에 포함됩니다.</caption>
      <thead><tr>{["언어·항목", "대기", "저장됨", "실패", "4회 소진", "재시도 대기", "현재 보류", "최고령 실패", "마지막 저장"].map((label) => <th key={label} className="px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
      <tbody>{summary.map((row) => <tr key={`${row.locale}-${row.field}`} className="border-t border-line">
        <td className="px-2 py-2">{LOCALES[row.locale]} · {FIELDS[row.field]}</td>
        {[row.pending, row.ready, row.failed, row.exhausted, row.retryWaiting, row.held].map((value, index) => <td key={index} className="px-2 py-2">{value.toLocaleString("ko-KR")}</td>)}
        <td className="px-2 py-2">{formatDetailTime(row.oldestFailedAt)}</td><td className="px-2 py-2">{formatDetailTime(row.lastSavedAt)}</td>
      </tr>)}</tbody>
    </table></div>
    <form action="/admin/translations" className="flex flex-wrap items-center gap-3 text-[14px]">
      <label>상태<select name="state" defaultValue={state} className="ml-2 min-h-11 rounded-lg border border-line px-2">{Object.entries(STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>언어<select name="locale" defaultValue={locale ?? ""} className="ml-2 min-h-11 rounded-lg border border-line px-2"><option value="">전체</option>{Object.entries(LOCALES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>항목<select name="field" defaultValue={field ?? ""} className="ml-2 min-h-11 rounded-lg border border-line px-2"><option value="">전체</option>{Object.entries(FIELDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>제품<input name="q" defaultValue={q} maxLength={120} placeholder="이름·slug·ID" className="ml-2 min-h-11 rounded-lg border border-line px-2" /></label>
      <button className="min-h-11 rounded-lg border border-line px-4">조회</button>
    </form>
    <p className="text-[14px] text-fg-2">조건에 맞는 수요 기록 {queue.count.toLocaleString("ko-KR")}건 · 오래된 상태 변경부터 표시합니다.</p>
    {queue.items.length === 0 && <p className="text-[14px]">조건에 맞는 수요 기록이 없습니다.</p>}
    {queue.items.map((entry) => <section key={`${entry.productId}-${entry.locale}-${entry.field}-${entry.updatedAt}`} className="rounded-xl border border-line p-4 text-[13px]">
      <h2 className="text-[16px] font-semibold"><Link prefetch={false} href={`/admin/products/${entry.slug}`} className="underline">{entry.name}</Link> · {LOCALES[entry.locale]} · {FIELDS[entry.field]}</h2>
      <p className="mt-2">{STATES[entry.status]} · 시도 {entry.attempts}/{PRODUCT_TRANSLATION_MAX_ATTEMPTS} · 오류 {entry.errorCode ?? "없음"}</p>
      <p className="mt-1 text-fg-2">상태 변경 {formatDetailTime(entry.updatedAt)} · 다음 시도 {formatDetailTime(entry.retryAt)} · 모델 {entry.model || "없음"}</p>
      <p className="mt-2 text-fg-2">{entry.sourceMatches ? "현재 원문과 일치합니다." : "현재 원문과 다릅니다. 저장된 번역은 공개에 사용되지 않습니다."} {REASONS[entry.recoveryReason]}</p>
      <details className="mt-3"><summary className="cursor-pointer text-fg-2">원문·저장본·해시 확인</summary>
        <div className="mt-2 space-y-2 rounded-lg bg-bg-soft p-3">
          <p className="break-all font-mono">저장 원문 hash: {entry.sourceHash}<br />현재 원문 hash: {entry.currentSourceHash}</p>
          <p>원문 언어 기록: {entry.sourceLocale ?? "확인되지 않음"} · 현재 공개 대상: {entry.eligible ? "예" : "아니오"}</p>
          <p className="whitespace-pre-wrap break-words">원문: {entry.sourceText || "비어 있음"}</p>
          <p className="whitespace-pre-wrap break-words">저장본: {entry.text ?? "없음"}</p>
        </div>
      </details>
      {entry.recovery && <TranslationRetryForm item={entry} csrfToken={csrfToken} expiresAt={admin.exp} />}
    </section>)}
    {queue.nextCursor && <Link prefetch={false} href={`/admin/translations?${next}`} className="inline-block min-h-11 py-3 text-[14px] underline">다음 기록</Link>}
  </main>;
}
