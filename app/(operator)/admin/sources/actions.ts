'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { previewFeedSource, type FeedPreview } from '@/lib/crawl/feed-preview';
import { feedSourceSchema, type FeedSourceConfig } from '@/lib/crawl/feed-source-schema';
import { saveFeedSource } from '@/lib/crawl/feed-source-store';
import { intervalOverridable, validIntervalMs } from '@/lib/jobs/job-intervals';
import { logger } from '@/lib/observability/logger';
import { runtimeSettingsIssueMessage } from '@/lib/operations/admin-runtime-settings';
import { webWriteAction } from '@/lib/operations/dr/web-gate';
import { saveRuntimeSettings } from '@/lib/operations/runtime-settings';

/**
 * 수집·작업 화면(2026-11-12 운영 콘솔 조각 4a)의 서버 동작 — 모두 쓰기 관문(webWriteAction: 읽기 전용 미리보기·DR fence 거절)과 관리자 확인을 지난다.
 * - 잡 주기 바꾸기: 운영 설정 jobs.<잡>.intervalMs 를 기존 저장(saveRuntimeSettings — 판 compare-and-set·범위 검사·감사 runtime-settings-save)으로. scheduler 가 30초 안에 읽는다.
 * - 글 목록 수집원 추가·고침·켜고 끄기: 크롤 설정 discover.feeds 한 줄(saveFeedSource — 화면이 본 값 compare-and-set·감사 crawl-source-save). 검색 신호는 건드리지 않는다.
 * - 미리 보기: 주소를 한 번 읽어 센다 — 아무것도 쓰지 않는다(관문은 다른 동작과 같이 지난다).
 * 작업 멈춤·재개는 기존 동작(status/job-control-actions.ts controlJobAction)을 그대로 쓴다.
 */
const UNAUTHORIZED = '권한이 없습니다. 다시 로그인해주세요.';

export type IntervalSaveState = { ok?: true; message?: string; issues?: string[] } | null;

export const saveJobIntervalAction = webWriteAction(async function saveJobIntervalAction(_previous: IntervalSaveState, form: FormData): Promise<IntervalSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: [UNAUTHORIZED] };
  const job = String(form.get('job') ?? '');
  if (!intervalOverridable(job)) return { issues: ['주기를 바꿀 수 없는 작업입니다(요청될 때만 도는 작업).'] };
  const revisionText = String(form.get('expectedRevision') ?? '').trim();
  const expectedRevision = /^\d{1,15}$/.test(revisionText) ? Number(revisionText) : NaN;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return { issues: ['운영 설정의 판(revision)을 읽지 못했습니다. 새로고침해주세요.'] };
  const reset = form.get('reset') === 'on';
  const minutesText = String(form.get('minutes') ?? '').trim();
  const intervalMs = reset ? null : /^\d{1,4}$/.test(minutesText) ? Number(minutesText) * 60_000 : NaN;
  if (intervalMs !== null && !validIntervalMs(intervalMs)) return { issues: ['주기는 1분~1,440분(24시간) 사이의 정수 분으로 적어 주세요.'] };
  try {
    const result = await saveRuntimeSettings({ jobs: { [job]: { intervalMs } } }, admin.login, { expectedRevision, group: 'jobs' });
    if (!result.ok) return { issues: result.issues.map(runtimeSettingsIssueMessage) };
    logger.info('admin.job_interval_saved', { login: admin.login, job, intervalMs, revision: result.revision });
    for (const path of ['/admin/sources', '/admin/status', '/admin/flow']) revalidatePath(path);
    return { ok: true, message: `저장했습니다(revision ${result.revision}). scheduler 가 30초 안에 읽고 다음 예약부터 씁니다.` };
  } catch (error) {
    return { issues: [runtimeSettingsIssueMessage(error instanceof Error ? error.message : '저장하지 못했습니다. 새로고침해 지금 상태를 확인해주세요.')] };
  }
});

export type FeedSaveState = { ok?: true; message?: string; issues?: string[]; id?: string } | null;

const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
/** 새 수집원의 열쇠 — 피드 호스트 + 주소·고를 글의 해시 6자리(같은 주소·규칙을 두 번 넣지 않게) */
function newFeedId(url: string, titlePrefix: string): string {
  let host = 'feed';
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'feed'; } catch { /* 주소 검사는 스키마가 한다 */ }
  return `${/^[a-z0-9]/.test(host) ? host : `f${host}`}-${createHash('sha256').update(`${url}\n${titlePrefix.toLowerCase()}`).digest('hex').slice(0, 6)}`;
}
/** 폼 → 수집원 설정. 새 수집원의 열쇠는 주소·고를 글로 정한다(같은 주소·규칙을 두 번 넣지 않게) */
function feedFromForm(form: FormData): { feed: FeedSourceConfig | null; issues: string[] } {
  const url = field(form, 'url'), titlePrefix = field(form, 'titlePrefix');
  const id = field(form, 'id') || newFeedId(url, titlePrefix);
  const linkKind = field(form, 'linkKind');
  const parsed = feedSourceSchema.safeParse({
    id, name: field(form, 'name'), url, titlePrefix,
    link: linkKind === 'entry-link' ? { kind: 'entry-link' }
      : { kind: 'page-title', titleClass: field(form, 'titleClass'), linkClass: field(form, 'linkClass'), bodyId: field(form, 'bodyId') || null },
    intervalMinutes: Number(field(form, 'intervalMinutes')), priority: Number(field(form, 'priority')),
    enabled: form.get('enabled') === 'on', requireEvidence: form.get('requireEvidence') === 'on',
  });
  if (parsed.success) return { feed: parsed.data, issues: [] };
  return { feed: null, issues: parsed.error.issues.map(issue => `${FEED_FIELD_LABELS[String(issue.path[0])] ?? '수집원'}: ${issue.message}`) };
}
const FEED_FIELD_LABELS: Record<string, string> = { name: '이름', url: '주소', titlePrefix: '고를 글', link: '제품 링크', intervalMinutes: '주기', priority: '우선순위', id: '열쇠' };

/** 글 목록 수집원 저장 — 새로 넣기(expected 비움) · 고치기(expected = 화면이 본 설정 JSON) */
export const saveFeedSourceAction = webWriteAction(async function saveFeedSourceAction(_previous: FeedSaveState, form: FormData): Promise<FeedSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: [UNAUTHORIZED] };
  const { feed, issues } = feedFromForm(form);
  if (!feed) return { issues };
  let expected: FeedSourceConfig | null = null;
  const expectedText = String(form.get('expected') ?? '');
  if (expectedText) {
    const parsed = (() => { try { return feedSourceSchema.safeParse(JSON.parse(expectedText)); } catch { return null; } })();
    if (!parsed?.success) return { issues: ['화면의 값을 읽지 못했습니다. 새로고침해주세요.'] };
    expected = parsed.data;
    if (expected.id !== feed.id) return { issues: ['다른 수집원의 값입니다. 새로고침해주세요.'] };
  }
  const result = await saveFeedSource({ next: feed, expected, actor: admin.login, reason: field(form, 'reason') });
  if (!result.ok) return { issues: result.issues };
  logger.info('admin.feed_source_saved', { login: admin.login, feed: feed.id, created: result.created, enabled: feed.enabled });
  for (const path of ['/admin/sources', '/admin/settings', '/admin/status']) revalidatePath(path);
  return { ok: true, id: feed.id, message: result.created
    ? `「${feed.name}」을 ${feed.enabled ? '켰습니다' : '꺼 둔 채 넣었습니다'}. 글 목록 작업의 다음 회차부터 읽습니다.`
    : `「${feed.name}」을 저장했습니다. 글 목록 작업의 다음 회차부터 씁니다.` };
});

/** 미리 보기 — 주소를 한 번 읽어 고른 글·저장소·사이트만 있는 글을 센다. 쓰지 않는다 */
export const previewFeedSourceAction = webWriteAction(async function previewFeedSourceAction(input: { url: string; titlePrefix: string;
  link: FeedSourceConfig['link'] }): Promise<FeedPreview> {
  const admin = await currentAdmin();
  if (!admin) return { ok: false, reason: 'unauthorized' };
  const parsed = feedSourceSchema.pick({ url: true, titlePrefix: true, link: true }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid_input' };
  try { return await previewFeedSource(parsed.data, { pageLimit: 10 }); }
  catch (error) {
    logger.warn('admin.feed_preview_failed', { login: admin.login, errorName: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'preview_failed' };
  }
});
