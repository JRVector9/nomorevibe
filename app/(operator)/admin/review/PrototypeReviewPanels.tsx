import Link from "next/link";
import type { reviewQueueCauses } from "@/lib/crawl/admin-review";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { heldQwenRetryStatus } from "@/lib/crawl/held-qwen-retry";
import { splitTiebreakStatus } from "@/lib/crawl/gate-split-tiebreak-read";
import { currentModelEnv } from "@/lib/operations/model-env";
import { CAUSE_GUIDE } from "./causes";
import { SECOND_FILTERS } from "./stages";
import { UPDATED_WINDOWS } from "./ListToolbar";
import { prototypeReviewFilter, PROTOTYPE_AI_FILTERS } from "./PrototypeReviewQuery";
import { ReasonLanguageToggle } from "./ReasonText";
import { RequeueResolved } from "./RequeueResolved";
import { SplitTiebreakSwitch } from "./SplitTiebreakSwitch";
import { HeldQwenRetryPanel } from "./HeldQwenRetryPanel";

type CausesRead = () => ReturnType<typeof reviewQueueCauses>;

/** These auxiliary reads stream independently; a closed panel never gates the main queue. */
export async function PrototypeReviewFilters({ filter, loadCauses }: { filter: ReturnType<typeof prototypeReviewFilter>; loadCauses: CausesRead }) {
  const causes = await loadCauses().catch(() => null);
  if (!causes) return <p className="panel-body notice amber" role="status">갈래 집계를 읽지 못했습니다. 현재 목록은 유지되며 새로고침해 다시 확인할 수 있습니다.</p>;
  const { tab, stage, cause, ai, second, q, updated, sort, rawState } = filter;
  return <form action="/admin/review" className="panel-body toolbar"><input type="hidden" name="tab" value={tab} />{rawState && <input type="hidden" name="state" value={rawState} />}<input type="hidden" name="stage" value={stage} /><input type="hidden" name="q" value={q} /><input type="hidden" name="sort" value={sort} />
    <select name="cause" defaultValue={cause} aria-label="검수 갈래"><option value="">갈래 전체</option>{causes.counts.map(row => <option value={row.cause} key={row.cause}>{CAUSE_GUIDE[row.cause].label} · {row.count}</option>)}</select>
    <select name="ai" defaultValue={ai} aria-label="1차 AI 판단"><option value="">1차 판단 전체</option>{PROTOTYPE_AI_FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select name="second" defaultValue={second} aria-label="2차 판단"><option value="">2차 판단 전체</option>{SECOND_FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="published">공개분 확인</option></select>
    <select name="updated" defaultValue={updated} aria-label="최근 푸시 기간">{UPDATED_WINDOWS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className="button">적용</button><Link className="text-button" href={`/admin/review?tab=${tab}`}>조건 초기화</Link>
  </form>;
}

export async function PrototypeReviewLanguage() {
  const env = await currentModelEnv().catch(() => null);
  return <ReasonLanguageToggle model={env?.translate || "작업별 순위에서 확인"} done={null} total={null} />;
}

export async function PrototypeReviewManagement({ settings, loadCauses }: { settings: CrawlSettings; loadCauses: CausesRead }) {
  const [causes, heldQwen, tiebreak] = await Promise.all([
    loadCauses().catch(() => null), heldQwenRetryStatus(settings).catch(() => null), splitTiebreakStatus().catch(() => null),
  ]);
  const resolved = causes?.counts.find(row => row.cause === "resolved");
  return <div className="panel-body stack">{resolved && <RequeueResolved count={resolved.count} />}{!causes && <p className="notice amber" role="status">현재 규칙의 갈래 집계를 읽지 못해 일괄 재심사 대상을 확인할 수 없습니다.</p>}<SplitTiebreakSwitch value={settings.qwenAuto.splitTiebreak} status={tiebreak} /><HeldQwenRetryPanel status={heldQwen} /><p className="small muted">운영 설정은 현재 값을 다시 확인하고 변경 사유를 남기는 기존 절차를 사용합니다.</p></div>;
}
