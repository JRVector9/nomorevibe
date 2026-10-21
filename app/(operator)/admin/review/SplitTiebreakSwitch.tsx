import type { SplitTiebreakStatus } from '@/lib/crawl/gate-split-tiebreak-read';
import { formatDetailTime } from '@/lib/format/time';
import { QwenAutoStepSwitch } from '../components/QwenAutoStepSwitch';
import { TIEBREAK_APPROVE_BADGE, TIEBREAK_DAILY_CAP_BADGE, TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE } from './tiebreak';

const n = (value: number) => value.toLocaleString('ko-KR');

/**
 * 2차 갈림 판가름 — 관문에서 갈린 보류를 gpu3090 Qwen-v2 에 한 번 더 묻고(lib/crawl/gate-split-tiebreak.ts), Qwen-v2 가 거부하면 M3 DeepSeek 이
 * 따로 확인한다(gate-split-confirm.ts — 사람 검토 잡). 둘 다 거부해야 닫는다. 기본 꺼짐(qwenAuto.splitTiebreak).
 * 켬/끔·한 틱의 수·하루 자동 거부 상한은 화면이 본 값과 같을 때만 바뀌고(compare-and-set), 켜는 바꿈은 확인 창에서 사유를 받는다.
 * 저장된 값이 깨졌으면 꺼진 것으로 읽는다.
 */
export function SplitTiebreakSwitch({ value, status }: {
  value: { enabled: boolean; perTick: number; dailyRejectCap: number }; status: SplitTiebreakStatus | null;
}) {
  const { enabled, perTick, dailyRejectCap } = value;
  // 접어 두어도 머리 줄에 상태가 보인다 — 처리·DeepSeek 확인 대기·오늘 자동 거부/상한·남음·두 단계의 마지막 오류(그 뒤 다시 받았는지)
  const lastError = (error: { code: string; at: string } | null | undefined, success: string | null | undefined) => error
    ? `${error.code} (${formatDetailTime(error.at)})${success && success > error.at ? ' — 그 뒤 다시 받음' : ''}` : '없음';
  const summary = status
    ? `처리 ${n(status.processed)} · DeepSeek 확인 대기 ${n(status.awaitingDeepseek)} · 오늘 자동 거부 ${n(status.rejectedToday)}/${n(dailyRejectCap)}`
      + ` · 승인 대기 ${n(status.approvedWaiting)} · 남음 ${n(status.remaining)}`
      + ` · 마지막 오류 Qwen ${lastError(status.lastError, status.lastSuccessAt)} · DeepSeek ${lastError(status.deepseekLastError, status.deepseekLastSuccessAt)}`
      + (status.backoffUntil ? ` · gpu3090 ${formatDetailTime(status.backoffUntil)}까지 물러남` : '')
      + (status.deepseekRetryAt ? ` · DeepSeek ${formatDetailTime(status.deepseekRetryAt)}에 다시` : '')
    : '상태를 읽지 못했습니다';
  return <details id="split-tiebreak" className="rounded-[10px] border border-line px-4 py-2 text-[13px]">
    <summary className="cursor-pointer text-fg-2">
      <b className="font-semibold text-fg">갈림 판가름 Qwen-v2 + DeepSeek</b> {enabled ? '켜짐' : '꺼짐'} · <span className="font-mono">{summary}</span>
    </summary>
    <div className="mt-2 flex flex-col gap-2">
      <span className="text-[14px] font-semibold">2차 갈림 판가름 — Qwen-v2 세 번째 표, DeepSeek 확인</span>
      <p className="leading-relaxed text-fg-3">1차 승인·2차 반대로 갈린 보류를 gpu3090 Qwen-v2 에 관문과 같은 입력으로 한 번 더 묻습니다.
        Qwen-v2 가 2차 거부와 같이 거부하면(확신 0.90 이상, 적용 모드에서만) M3 DeepSeek 에 같은 입력으로 따로 묻고, DeepSeek 도 거부해야(확신 0.70 이상)
        거부로 닫습니다 — 하루(KST) {n(dailyRejectCap)}건까지. DeepSeek 이 승인·보류하거나 실패하면 «{TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE}»,
        상한에 닿으면 «{TIEBREAK_DAILY_CAP_BADGE}» 배지로 사람에게 남깁니다. Qwen-v2 가 승인하면 발행하지 않고 «{TIEBREAK_APPROVE_BADGE}» 배지로
        목록 맨 앞에 둡니다.</p>
      <QwenAutoStepSwitch key={`${enabled}:${perTick}:${dailyRejectCap}`} step="splitTiebreak" value={value} title="갈림 판가름" maxPerTick={50}
        extra={{ name: 'dailyRejectCap', label: '하루 자동 거부 상한', unit: '건', min: 0, max: 500 }}
        enableNotes={['관문에서 갈린 사람 확인 보류를 gpu3090 Qwen-v2 에 한 번 더 묻습니다(2차 잡).',
          'Qwen-v2 거부(확신 0.90 이상)를 M3 DeepSeek 이 따로 거부로 확인하면(확신 0.70 이상) 사람 없이 거부로 닫습니다 — 적용 모드에서만, 하루 상한까지.',
          'DeepSeek 확인은 사람 검토 잡이 위임 뒤에 차례로 묻습니다 — M3 에 두 호출을 겹쳐 띄우지 않습니다.',
          '관문 표나 1차가 같은 Qwen 모델이면 묻지 않습니다.']} />
      {status && <p className="font-mono text-fg-3">
        사람에게 남김 — DeepSeek 확인 안 됨 {n(status.held.deepseek)} · 하루 상한 {n(status.held.dailyCap)} · 카탈로그 {n(status.held.catalog)}
        {' '}· 대상 아님(원본·정책 바뀜·같은 모델) {n(status.ineligible)} · 그 밖의 거부 의견(다수 아님·낮은 확신) {n(Math.max(0, status.heldReject - status.held.catalog))}
        {' '}· 실패 소진 {n(status.exhausted)} · 24시간 처리 {n(status.day.processed)} · 거부 {n(status.day.rejected)}
      </p>}
    </div>
  </details>;
}
