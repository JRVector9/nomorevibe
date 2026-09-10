import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Panel } from "@/components/Panel";
import { currentAdmin } from "@/lib/auth/admin";
import { getSettings } from "@/lib/crawl/settings";
import type { NewsState } from "@/lib/db/schema";
import type { NewsCursor, NewsSourceState } from "@/lib/news/refresh";
import { countNewsByState, listNewsForAdmin, newsJobState } from "@/lib/news/repository";
import { NEWS_SOURCES, newsSource, type NewsSource } from "@/lib/news/sources";
import { NewsBoard } from "./NewsBoard";
import { NewsSettingsForm } from "./NewsSettingsForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI 소식 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<{ state?: string }> };

const FILTERS: { key: NewsState | "all"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "approved", label: "게시" },
  { key: "pending", label: "대기" },
  { key: "hidden", label: "숨김" },
];
const KIND_LABEL: Record<NewsSource["kind"], string> = { feed: "RSS·Atom", sitemap: "사이트맵", npm: "npm" };
const SECTION_LABEL: Record<NewsSource["section"], string> = { news: "공식 발표 · 홈 노출", release: "도구 릴리스" };

const at = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });

/** 출처 한 줄의 마지막 수집 결과 */
function sourceStatus(source: NewsSource, state: NewsSourceState | undefined): { status: string; failing: boolean } {
  if (!state) return { status: "아직 수집 전", failing: false };
  if (!state.ok) return { status: `${at(state.checkedAt)} · 실패 ${state.error ?? ""}`, failing: true };
  if (source.kind === "sitemap" && state.found === 0) {
    return { status: `${at(state.checkedAt)} · 기준선 ${state.seen?.length ?? 0}개, 새 글을 기다립니다`, failing: false };
  }
  return { status: `${at(state.checkedAt)} · ${state.found}건 확인, 새 글 ${state.added}건`, failing: false };
}

export default async function AdminNewsPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const { state: rawState } = await searchParams;
  const filter = FILTERS.find((item) => item.key === rawState)?.key ?? "all";

  const [settings, job, counts, items] = await Promise.all([
    getSettings(),
    newsJobState(),
    countNewsByState(),
    listNewsForAdmin(filter),
  ]);
  const cursor = (job?.cursor ?? null) as NewsCursor | null;
  const disabled = new Set(settings.news.disabledSources);
  const total = counts.approved + counts.pending + counts.hidden;

  return (
    <main className="mx-auto max-w-[1000px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">AI 소식</h1>
        <span className="text-[13px] text-fg-3">{admin.login}</span>
      </div>
      <p className="mt-2 max-w-[68ch] text-[13.5px] leading-[1.7] text-fg-2">
        회사 공식 피드에서 한 시간마다 모읍니다. 홈의 &ldquo;빌더를 위한 AI 소식&rdquo;에는 공식 발표만, 회사마다 가장 최근 것 하나씩 오릅니다.
        코딩 도구 릴리스는 모아 두기만 합니다.
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <Panel title="수집 설정" note="체크를 끈 출처는 수집하지 않습니다. 이미 모은 글은 그대로 남습니다.">
          <NewsSettingsForm
            autoApprove={settings.news.autoApprove}
            sources={NEWS_SOURCES.map((source) => ({
              key: source.key,
              name: source.name,
              vendor: source.vendor,
              kindLabel: KIND_LABEL[source.kind],
              sectionLabel: SECTION_LABEL[source.section],
              url: source.url,
              enabled: !disabled.has(source.key),
              ...sourceStatus(source, cursor?.sources[source.key]),
            }))}
          />
        </Panel>

        <Panel title="모은 글" note={`전체 ${total.toLocaleString("ko-KR")}건 · 최근 게시일 순으로 200건까지`}>
          <nav className="mb-3 flex flex-wrap gap-2" aria-label="상태 필터">
            {FILTERS.map((item) => {
              const count = item.key === "all" ? total : counts[item.key];
              return (
                <Link key={item.key} href={item.key === "all" ? "/admin/news" : `/admin/news?state=${item.key}`}
                  aria-current={filter === item.key ? "page" : undefined}
                  className={`rounded-full border px-3 py-1 text-[13px] ${filter === item.key ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-fg-2"}`}>
                  {item.label} {count.toLocaleString("ko-KR")}
                </Link>
              );
            })}
          </nav>
          <NewsBoard
            key={filter}
            items={items.map((item) => ({
              id: item.id,
              source: newsSource(item.sourceKey)?.name ?? item.sourceKey,
              title: item.title,
              url: item.url,
              publishedAt: item.publishedAt.toISOString(),
              state: item.state,
            }))}
          />
        </Panel>
      </div>
    </main>
  );
}
