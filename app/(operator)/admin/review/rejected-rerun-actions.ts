'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentAdmin } from '@/lib/auth/admin';
import { reviewQueueCauses } from '@/lib/crawl/admin-review';
import {
  prepareRejectedRerun,
  rerunRejectedBatch,
  rerunRejectedSelection,
} from '@/lib/crawl/admin-review-rejected-rerun';
import { humanQueueOverview } from '@/lib/crawl/review-overview';
import { getSettings, settingsUnreadable } from '@/lib/crawl/settings';
import { onPrimary } from '@/lib/db';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

import {
  prototypeReviewFilter,
  prototypeReviewNeeds,
  prototypeReviewOptions,
} from './PrototypeReviewQuery';
import type {
  RejectedRerunSnapshot,
  RejectedRerunTarget,
} from './rejected-rerun-contract';

const MAX_QUERY_LENGTH = 4096;
const GENERIC_ERROR =
  '응답을 확인하지 못했습니다. 자동 재전송하지 말고 새로고침해 처리 상태를 확인하세요.';
const CONDITION_ERROR = '조건을 확인하지 못했습니다.';

class ScopeError extends Error {
  constructor() {
    super('rejected_rerun_scope');
    this.name = 'ScopeError';
  }
}

const sha256Hex = /^[0-9a-f]{64}$/;

const targetSchema = z
  .object({
    repo: z.string().min(1).max(200),
    inputHash: z.string().regex(sha256Hex),
    sourceRevisionHash: z.string().regex(sha256Hex),
    candidateRevisionHash: z.string().regex(sha256Hex),
  })
  .strict();

const targetsSchema = z.array(targetSchema).min(1).max(50);

const snapshotSchema = z
  .object({
    query: z.string().max(MAX_QUERY_LENGTH),
    upperId: z.number().int().nonnegative(),
    afterId: z.number().int().nonnegative(),
    startedAt: z.string().min(1),
    total: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    skipReasons: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .strict();

function normalizeQuery(
  filter: ReturnType<typeof prototypeReviewFilter>,
): string {
  const params = new URLSearchParams();
  params.set('tab', filter.tab);
  params.set('stage', filter.stage);
  params.set('state', filter.rawState);
  params.set('cause', filter.cause);
  params.set('ai', filter.ai);
  params.set('second', filter.second);
  params.set('q', filter.q);
  params.set('updated', filter.updated);
  params.set('sort', filter.sort);
  params.set('reason', filter.reason);
  return params.toString();
}

async function readScope(query: string) {
  if (query.length > MAX_QUERY_LENGTH) throw new ScopeError();

  const params = new URLSearchParams(query);
  const allowedKeys = new Set(["q", "stage", "tab", "state", "sort", "reason", "ai", "updated", "cause", "second"]);
  const seenKeys = new Set<string>();
  for (const key of params.keys()) {
    if (!allowedKeys.has(key) || seenKeys.has(key)) throw new ScopeError();
    seenKeys.add(key);
  }

  const filter = prototypeReviewFilter(Object.fromEntries(params));

  if (params.has("tab") && params.get("tab") !== filter.tab) throw new ScopeError();
  if (params.has("stage") && params.get("stage") !== filter.stage) throw new ScopeError();
  if (params.has("cause") && params.get("cause") !== filter.cause) throw new ScopeError();
  if (params.has("ai") && params.get("ai") !== filter.ai) throw new ScopeError();
  if (params.has("second") && params.get("second") !== filter.second) throw new ScopeError();
  if (params.has("updated") && params.get("updated") !== filter.updated) throw new ScopeError();
  if (params.has("sort") && params.get("sort") !== filter.sort) throw new ScopeError();
  if (params.has("reason") && params.get("reason") !== filter.reason) throw new ScopeError();

  const rawQ = params.get("q");
  if (rawQ !== null && rawQ.trim() !== filter.q) throw new ScopeError();

  const rawState = params.get("state");
  const candidateStates = new Set(["all", "pending", "new", "approved", "needs_review", "rejected", "published"]);
  if (rawState !== null && rawState !== "" && !candidateStates.has(rawState)) throw new ScopeError();

  const needs = prototypeReviewNeeds(filter);

  const settings = await getSettings();
  if (settingsUnreadable(settings)) throw new ScopeError();

  const [causes, overview] = await Promise.all([
    needs.causes ? reviewQueueCauses(settings) : Promise.resolve(null),
    needs.overview ? humanQueueOverview(settings) : Promise.resolve(null),
  ]);

  if (needs.causes && causes?.truncated) throw new ScopeError();

  const options = prototypeReviewOptions(filter, causes, overview);
  if (options.state !== 'rejected' || filter.second === 'published') {
    throw new ScopeError();
  }

  return { options, query: normalizeQuery(filter) };
}

export const prepareRejectedRerunAction = webWriteAction(async function prepareRejectedRerunAction(
  form: FormData,
): Promise<{ snapshot?: RejectedRerunSnapshot; error?: string }> {
  try {
    return await onPrimary(async () => {
      const admin = await currentAdmin();
      if (!admin) return { error: CONDITION_ERROR };

      const raw = form.get('query');
      if (typeof raw !== 'string') throw new ScopeError();

      const scope = await readScope(raw);
      const snapshot = await prepareRejectedRerun(scope.options, scope.query);
      return { snapshot };
    });
  } catch (error) {
    if (error instanceof ScopeError) return { error: CONDITION_ERROR };
    return { error: GENERIC_ERROR };
  }
});

export const continueRejectedRerunAction = webWriteAction(async function continueRejectedRerunAction(
  snapshot: RejectedRerunSnapshot,
): Promise<{
  snapshot?: RejectedRerunSnapshot;
  done?: boolean;
  error?: string;
}> {
  try {
    return await onPrimary(async () => {
      const admin = await currentAdmin();
      if (!admin) return { error: GENERIC_ERROR };

      const parsed = snapshotSchema.safeParse(snapshot);
      if (!parsed.success) return { error: GENERIC_ERROR };

      const scope = await readScope(parsed.data.query);
      if (scope.query !== parsed.data.query) return { error: GENERIC_ERROR };

      const result = await rerunRejectedBatch({
        snapshot: parsed.data,
        options: scope.options,
        actor: admin.login,
      });

      if (result.done) {
        revalidatePath('/admin/review');
        revalidatePath('/admin/flow');
      }

      return { snapshot: result.snapshot, done: result.done };
    });
  } catch {
    return { error: GENERIC_ERROR };
  }
});

export const rerunSelectedRejectedAction = webWriteAction(async function rerunSelectedRejectedAction(
  targets: RejectedRerunTarget[],
): Promise<{
  queued?: number;
  skipped?: number;
  error?: string;
  skipReasons?: Record<string, number>;
}> {
  try {
    return await onPrimary(async () => {
      const admin = await currentAdmin();
      if (!admin) return { error: GENERIC_ERROR };

      const parsed = targetsSchema.safeParse(targets);
      if (!parsed.success) return { error: GENERIC_ERROR };

      const result = await rerunRejectedSelection(parsed.data, admin.login);

      revalidatePath('/admin/review');
      revalidatePath('/admin/flow');

      return result;
    });
  } catch {
    return { error: GENERIC_ERROR };
  }
});
