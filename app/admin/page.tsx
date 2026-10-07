import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings, getSettingsMeta, settingsDrift } from "@/lib/crawl/settings";
import { candidateCounts } from "@/lib/crawl/repository";
import { signalYields } from "@/lib/operations/dashboard";
import { logger } from "@/lib/observability/logger";
import { SettingsForm } from "./SettingsForm";
import { SettingsDriftNotice } from "./SettingsDriftNotice";
import { LIST_KEYS, missingDefaults, searchUsage } from "./settings/model";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "크롤 설정 — NoMoreVibe", robots: { index: false } };

const fmt = (n: number) => n.toLocaleString("ko-KR");
const chip = "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold";

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[12px] border border-line bg-bg-card px-4 py-3.5">
      <span className="text-[13px] font-semibold text-fg-2">{label}</span>
      <span className="text-[26px] font-bold tabular-nums">{value}</span>
      <span className="text-[13px] text-fg-3">{note}</span>
    </div>
  );
}

/**
 * 크롤 설정 — 무엇을 찾아올지(검색 신호·수집 범위), 무엇을 올릴지(판정·거르는 목록), 누가 다시 볼지(1·2차 심사).
 * 2026-10-08 리디자인: 지난 7일 성과를 위에, 신호마다 수집·발행률을, 기본값과 다른 것은 해당 목록 안과 맨 아래에 둔다.
 */
export default async function AdminPage() {
  // middleware가 서명과 만료를 보고, 여기서 허용목록을 다시 확인한다 — 쿠키를 발급한 뒤 목록에서 빠졌을 수 있다
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const [settings, meta, counts] = await Promise.all([getSettings(), getSettingsMeta(), candidateCounts()]);
  // 성과는 덤이다 — 집계가 실패해도 설정은 고칠 수 있어야 한다
  const yields = await signalYields(settings, 7).catch((error) => {
    logger.warn("admin.signal_yields_unavailable", { error });
    return [];
  });
  const waiting = counts.needs_review ?? 0;
  const drift = settingsDrift(settings);

  const yieldsByLabel = Object.fromEntries(yields.map((row) => [row.signal, { enqueued: row.enqueued, published: row.published, gated: row.gated }]));
  const enqueued = yields.reduce((sum, row) => sum + row.enqueued, 0);
  const published = yields.reduce((sum, row) => sum + row.published, 0);
  const gated = yields.reduce((sum, row) => sum + row.gated, 0);
  const usage = searchUsage(settings.discover.pagesPerTick);
  const signalsOn = settings.discover.queries.filter((q) => q.enabled).length + (settings.discover.showHn.enabled ? 1 : 0);
  const listsDrifted = LIST_KEYS.filter((key) => missingDefaults(key, settings.judge[key]).length > 0).length;

  const sections: { href: string; label: string; badge?: React.ReactNode }[] = [
    { href: "#signals", label: "검색 신호", badge: <span className="text-fg-3">{signalsOn}/{settings.discover.queries.length + 1}</span> },
    { href: "#scope", label: "수집 범위" },
    { href: "#judge", label: "판정 기준" },
    { href: "#lists", label: "거르는 목록", badge: listsDrifted > 0 ? <span className="text-warn">● {listsDrifted}</span> : undefined },
    { href: "#first", label: "1차 심사" },
    { href: "#second", label: "2차 심사" },
    ...(drift.length > 0 ? [{ href: "#defaults", label: "기본값과 비교", badge: <span className="text-warn">{drift.length}</span> }] : []),
  ];

  return (
    <main className="mx-auto flex max-w-[1220px] flex-col gap-5 px-8 pb-12 pt-7 max-sm:px-4">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] font-bold tracking-tight">크롤 설정</h1>
          {settings.enabled
            ? <span className={`${chip} bg-up/10 text-up`}><span className="h-[7px] w-[7px] rounded-full bg-current" aria-hidden />수집 켜짐</span>
            : <span className={`${chip} bg-bg-hover text-fg-2`}><span className="h-[7px] w-[7px] rounded-full bg-current" aria-hidden />수집 꺼짐</span>}
          {waiting > 0 && <Link prefetch={false} href="/admin/review" className={`${chip} bg-accent-soft text-accent-ink`}>심사 대기 {fmt(waiting)}건 →</Link>}
          <span className="ml-auto text-[13px] text-fg-3">
            {meta && <>마지막 변경 <span className="font-mono">{meta.updatedAt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}</span> · {meta.updatedBy ?? "알 수 없음"} · </>}
            {admin.login}
          </span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="text-[13px] font-semibold text-fg-2 hover:text-fg">로그아웃</button>
          </form>
        </div>
        <p className="max-w-[72ch] text-[14px] text-fg-3">
          무엇을 찾아올지(검색 신호·수집 범위)와 무엇을 올릴지(판정·거르는 목록), 누가 다시 볼지(1·2차 심사)를 정합니다.
          저장하면 다음 틱부터 적용되고, 판정 기준은 보관한 원본으로 다시 판정합니다.
        </p>
      </header>

      <section aria-label="최근 7일" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure label="7일 수집" value={fmt(enqueued)} note={`신호 ${yields.length}개에서 들어온 후보`} />
        <Figure label="7일 발행" value={fmt(published)} note={enqueued ? `수집의 ${((published / enqueued) * 100).toFixed(1)}%` : "—"} />
        <Figure label="AI 흔적 없어 보류" value={fmt(gated)} note="흔적 필요 신호에서만" />
        <Figure label="검색 사용량" value={usage.percent} note={`시간당 ${fmt(usage.perHour)}회 / 한도 1,800회`} />
      </section>

      <div className="flex flex-wrap items-start gap-5">
        <aside aria-label="이 페이지" className="flex max-w-[200px] flex-[1_1_180px] flex-col gap-0.5 max-md:hidden">
          <span className="px-2.5 pb-1.5 text-[13px] font-semibold text-fg-3">이 페이지</span>
          <nav aria-label="설정 구획">
            {sections.map((section) => (
              <a key={section.href} href={section.href} className="flex justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-fg-2 hover:bg-bg-card">
                <span>{section.label}</span>{section.badge}
              </a>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
          <SettingsForm settings={settings} yields={yieldsByLabel} />
          <SettingsDriftNotice drift={drift} />
        </div>
      </div>
    </main>
  );
}
