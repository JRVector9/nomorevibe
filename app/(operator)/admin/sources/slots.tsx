import { isPausedJob } from "@/lib/jobs/status";
import { buildSourcesView } from "@/lib/operations/sources-model";
import { readSources } from "@/lib/operations/sources-read";
import { feedAddTaken, SourcesConsole } from "./SourcesConsole";
import { FeedSourceAdd, type FeedAddKind } from "./new/FeedSourceAdd";

type Csrf = { token: string; expiresAt: number } | null;

/**
 * 「수집·작업」 화면의 읽기 + 그리기(Suspense 안에서 기다린다). page.tsx 는 Next 가 정한 것만 내보낼 수 있어 여기 둔다 —
 * 시험은 이 함수를 그대로 기다려 그린다(읽기 모듈만 바꿔 끼운다).
 */
export async function SourcesSlot({ selected, openJob, readOnly, csrf, fresh = false }: { selected: string | null; openJob: string | null; readOnly: boolean;
  csrf: Csrf; fresh?: boolean }) {
  const read = await readSources(fresh);
  const view = buildSourcesView(read);
  const now = Date.parse(read.checkedAt);
  const jobs = Object.fromEntries((read.jobs ?? []).map(job => [job.name, { paused: isPausedJob({ notBefore: job.notBefore ? new Date(job.notBefore) : null }, now),
    notBefore: job.notBefore, version: read.versions?.[job.name] ?? 0 }]));
  return <SourcesConsole view={view} settings={read.settings} selected={selected} openJob={openJob} readOnly={readOnly} csrf={csrf} jobs={jobs} />;
}

/** 수집원 추가 — 이미 쓰는 신호 이름(겹치지 않게 미리 알린다)과 글 목록 작업 주기를 함께 넘긴다 */
export async function FeedSourceAddSlot({ kind, readOnly }: { kind: FeedAddKind | null; readOnly: boolean }) {
  const read = await readSources();
  const view = buildSourcesView(read);
  const feedJob = view.sources.find(source => source.feed?.legacy)?.intervalMs ?? null;
  return <FeedSourceAdd kind={kind} taken={feedAddTaken(view, read.settings)} jobIntervalMs={feedJob} readOnly={readOnly} />;
}
