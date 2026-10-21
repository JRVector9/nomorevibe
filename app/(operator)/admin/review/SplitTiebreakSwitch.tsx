import type { SplitTiebreakStatus } from '@/lib/crawl/gate-split-tiebreak-read';
import { formatDetailTime } from '@/lib/format/time';
import { QwenAutoStepSwitch } from '../components/QwenAutoStepSwitch';
import { TIEBREAK_APPROVE_BADGE } from './tiebreak';

const n = (value: number) => value.toLocaleString('ko-KR');

/**
 * 2차 갈림 판가름 — 관문에서 갈린 보류를 gpu3090 Qwen-v2 에 한 번 더 묻는다(lib/crawl/gate-split-tiebreak.ts). 기본 꺼짐(qwenAuto.splitTiebreak).
 * 켬/끔·한 틱의 수는 화면이 본 값과 같을 때만 바뀌고(compare-and-set), 켜는 바꿈은 확인 창에서 사유를 받는다. 저장된 값이 깨졌으면 꺼진 것으로 읽는다.
 */
export function SplitTiebreakSwitch({ enabled, perTick, status }: { enabled: boolean; perTick: number; status: SplitTiebreakStatus | null }) {
  // 접어 두어도 머리 줄에 상태가 보인다 — 처리·거부·승인 대기·남음·마지막 오류(그 뒤 다시 받았는지)
  const error = status?.lastError;
  const recovered = Boolean(error && status?.lastSuccessAt && status.lastSuccessAt > error.at);
  const summary = status
    ? `처리 ${n(status.processed)} · 거부로 닫음 ${n(status.rejected)} · 승인 대기 ${n(status.approvedWaiting)} · 남음 ${n(status.remaining)}`
      + ` · 마지막 오류 ${error ? `${error.code} (${formatDetailTime(error.at)})${recovered ? ' — 그 뒤 다시 받음' : ''}` : '없음'}`
      + (status.backoffUntil ? ` · ${formatDetailTime(status.backoffUntil)}까지 물러남` : '')
    : '상태를 읽지 못했습니다';
  return <details id="split-tiebreak" className="rounded-[10px] border border-line px-4 py-2 text-[13px]">
    <summary className="cursor-pointer text-fg-2">
      <b className="font-semibold text-fg">갈림 판가름 Qwen-v2</b> {enabled ? '켜짐' : '꺼짐'} · <span className="font-mono">{summary}</span>
    </summary>
    <div className="mt-2 flex flex-col gap-2">
      <span className="text-[14px] font-semibold">2차 갈림 판가름 — Qwen-v2 세 번째 표</span>
      <p className="leading-relaxed text-fg-3">1차 승인·2차 반대로 갈린 보류를 gpu3090 Qwen-v2 에 관문과 같은 입력으로 한 번 더 묻습니다.
        2차 거부와 같이 거부하면(확신 0.90 이상, 적용 모드에서만) 거부로 닫고, 승인하면 발행하지 않고 «{TIEBREAK_APPROVE_BADGE}» 배지로 목록 맨 앞에 둡니다.
        보류·실패·낮은 확신은 그대로 사람 몫입니다.</p>
      <QwenAutoStepSwitch key={`${enabled}:${perTick}`} step="splitTiebreak" value={{ enabled, perTick }} title="갈림 판가름" maxPerTick={50}
        enableNotes={['관문에서 갈린 사람 확인 보류를 gpu3090 Qwen-v2 에 한 번 더 묻습니다(2차 잡).',
          '독립 모델의 관문 거부가 있고 승인이 없을 때 Qwen-v2 도 거부하면(확신 0.90 이상) 사람 없이 거부로 닫습니다 — 적용 모드에서만.',
          '관문 표나 1차가 같은 Qwen 모델이면 묻지 않습니다.']} />
      {status && <p className="font-mono text-fg-3">
        거부 의견 남김(다수 아님·카탈로그·낮은 확신) {n(status.heldReject)} · 대상 아님(원본·정책 바뀜·같은 모델) {n(status.ineligible)} · 실패 소진 {n(status.exhausted)}
        {' '}· 24시간 처리 {n(status.day.processed)} · 거부 {n(status.day.rejected)}
      </p>}
    </div>
  </details>;
}
