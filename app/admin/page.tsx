import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings, getSettingsMeta } from "@/lib/crawl/settings";
import { candidateCounts } from "@/lib/crawl/repository";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "크롤 설정 — NoMoreVibe", robots: { index: false } };

export default async function AdminPage() {
  // middleware가 서명과 만료를 보고, 여기서 허용목록을 다시 확인한다 —
  // 쿠키를 발급한 뒤 목록에서 빠졌을 수 있다
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const [settings, meta, counts] = await Promise.all([
    getSettings(),
    getSettingsMeta(),
    candidateCounts(),
  ]);
  const waiting = counts.needs_review ?? 0;

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">크롤 설정</h1>
        <span className="text-[12.5px] text-fg-3">
          {settings.enabled ? (
            <span className="font-semibold text-up">수집 켜짐</span>
          ) : (
            <span className="font-semibold text-fg-3">수집 꺼짐</span>
          )}
        </span>
        <Link href="/admin/review" className="text-[12.5px] font-semibold text-fg-2 hover:text-fg">
          심사 큐{waiting > 0 && <span className="ml-1 text-accent">{waiting}</span>}
        </Link>
        <form action="/api/auth/logout" method="post" className="ml-auto">
          <span className="mr-3 text-[12.5px] text-fg-3">{admin.login}</span>
          <button type="submit" className="text-[12.5px] font-semibold text-fg-2 hover:text-fg">
            로그아웃
          </button>
        </form>
      </div>

      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        기준을 바꾸면 다음 틱부터 적용됩니다. 판정 기준은 수집한 원본을 다시 쓰므로, 바꾼 뒤
        재판정하면 GitHub을 다시 긁지 않고 결과가 바뀝니다.
      </p>

      {meta && (
        <p className="mt-1.5 font-mono text-[11.5px] text-fg-3">
          마지막 변경 {meta.updatedBy ?? "알 수 없음"} ·{" "}
          {meta.updatedAt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}
        </p>
      )}

      <SettingsForm settings={settings} />
    </main>
  );
}
