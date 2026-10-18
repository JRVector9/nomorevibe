import { z } from 'zod';
import { Panel } from '@/components/Panel';
import { formatDetailTime } from '@/lib/format/time';
import { SourceBufferSwitch } from './SourceBufferSwitch';

/** 수집 잡이 판정할 때마다 남기는 관측(lib/crawl/source-buffer.ts lockSourceBufferAdmission) — 판정 행과 같은 TX 에서 쓴다 */
export const SOURCE_BUFFER_OBSERVATION_KEY = 'crawl:source-buffer';
const decisionSchema = z.object({ blocked: z.boolean(), reason: z.enum(['ready', 'count_pressure', 'measurement_unknown']), revision: z.number().int().positive() });
const REASONS = { ready: '후단 여유(ready)', count_pressure: '후단 대기 많음(count_pressure)', measurement_unknown: '측정 불명(measurement_unknown)' };

/**
 * 원본 공급 조절(source buffer) — 지금 설정과 마지막 판정, 켜기·끄기(ops-v8 PR8). 전에는 SQL 로만 보고 바꿨다.
 * 새로 읽는 쿼리는 없다: 설정은 운영센터가 이미 읽은 크롤 설정, 판정은 이미 읽은 관측 목록에서 꺼낸다.
 * csrf 가 없으면(AUTH_SECRET 미설정) 보기만 한다.
 */
export function SourceBufferCard({ enabled, observation, csrf }: {
  enabled: boolean;
  observation: { value: unknown; observedAt: string } | undefined;
  csrf: { token: string; expiresAt: number } | null;
}) {
  const decision = observation ? decisionSchema.safeParse(observation.value) : null;
  return (
    <Panel title="원본 공급 조절(source buffer)" actions={<span className="text-[13px] text-fg-3">새</span>}
      note="켜 두면 후단 대기가 많을 때 아직 원본을 받지 않은 새 저장소의 수집을 미룹니다. 판정은 대기 수 기준이며 실측 처리율(R)은 아직 없습니다.">
      <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
        <div><dt className="text-fg-3">설정(discover.sourceBuffer)</dt>
          <dd className="mt-1 font-semibold">{enabled ? '켜짐(enabled)' : '꺼짐(disabled) · 기본값'}</dd></div>
        <div><dt className="text-fg-3">마지막 판정</dt>
          <dd className="mt-1 font-semibold">{!observation ? '기록 없음 — 켠 뒤 첫 수집 회차에 생깁니다'
            : !decision?.success ? '판정 기록을 읽지 못했습니다'
            : <>{decision.data.blocked ? '새 원본 보류(blocked)' : '새 원본 받음'} · {REASONS[decision.data.reason]} · 판(revision) {decision.data.revision.toLocaleString('ko-KR')}</>}</dd></div>
        {observation && <div><dt className="text-fg-3">판정 시각(DB)</dt>
          <dd className="mt-1 font-semibold"><time dateTime={observation.observedAt}>{formatDetailTime(observation.observedAt)}</time></dd></div>}
      </dl>
      {!enabled && observation && <p className="mt-2 text-[13px] text-fg-3">꺼져 있어 지금은 적용하지 않습니다 — 위 판정은 켜져 있던 때의 기록입니다.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {csrf ? <SourceBufferSwitch enabled={enabled} csrfToken={csrf.token} csrfExpiresAt={csrf.expiresAt} />
          : <p className="text-[13px] text-fg-3">관리자 서명 키(AUTH_SECRET)가 없어 여기서 바꿀 수 없습니다.</p>}
        <span className="text-[13px] text-fg-3">바꾸면 작업 로그에 전·후 값과 사유가 남습니다.</span>
      </div>
    </Panel>
  );
}
