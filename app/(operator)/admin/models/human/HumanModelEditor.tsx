import Link from 'next/link';
import { adminWorkspaceReadOnly } from '@/lib/operations/admin-workspace-preview';
import { configuredHumanModelsProbe } from '@/lib/operations/admin-models-human';
import { HUMAN_MODEL_STAGES, readHumanModelSource } from '@/lib/operations/human-model-source';
import { StageModelPoolsForm } from '../StageModelPoolsForm';
import { AssignmentForm, type AssignmentFormValues } from '../assignments/AssignmentForm';
import { HumanReviewSwitch } from '../../review/HumanReviewSwitch';

const SOURCE_LABELS = { table: '배정 표', pool: '사람 위임 검수 풀', default: '등록부 기본값', unknown: '확인 불가' } as const;

export async function HumanModelEditor() {
  let data: Awaited<ReturnType<typeof readHumanModelSource>>;
  try { data = await readHumanModelSource(); } catch {
    return <section className='grid gap-2 rounded-xl border border-line bg-bg-card p-3 text-[13px]'>
      <p role='alert' className='text-warn'>사람 확인 · AI 위임 설정을 읽지 못했습니다. 저장할 수 없습니다. 새로고침한 뒤 모델 연결 상태를 확인해 주세요.</p>
      <p><Link href='/admin/models' prefetch={false} className='text-accent-ink underline'>모델 연결 →</Link></p>
    </section>;
  }

  const preview = adminWorkspaceReadOnly();
  const unknown = data.unknown || data.source === 'unknown';
  const formReadOnly = preview || data.saveBlocked;
  const { enabled, generation } = data.settings.humanReview;
  const probes = preview || unknown || data.effectiveKeys.length === 0
    ? []
    : await configuredHumanModelsProbe(data.effectiveKeys, data.selection);
  const ready = !unknown && probes.length > 0 && probes.every(probe => probe.ready);
  const probeByKey = new Map(probes.map(probe => [probe.key, probe] as const));
  const modelLabel = data.effectiveModels.length === 0 ? '확인된 모델 없음'
    : data.effectiveModels.length === 1 ? data.effectiveModels[0].displayName
    : `${data.effectiveModels[0].displayName} 외 ${data.effectiveModels.length - 1}`;
  const modelLocation = data.source === 'table' ? '배정 표'
    : data.source === 'pool' ? '사람 위임 검수 풀'
    : data.source === 'default' ? '등록부 기본값' : '출처 확인 불가';
  const tableEffective = data.source === 'table';
  const poolStageIds = tableEffective ? HUMAN_MODEL_STAGES.filter(stage => stage !== 'human-review') : HUMAN_MODEL_STAGES;

  return <div className='grid gap-3 text-[13px]'>
    <section className='grid gap-2 rounded-xl border border-line bg-bg-card p-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div>
          <h2 className='text-[15px] font-semibold'>사람 확인 · AI 위임</h2>
          <p className='text-fg-2'>현재 출처: <strong>{SOURCE_LABELS[data.source]}</strong> · {modelLabel}</p>
        </div>
        <span className='rounded-full border border-line bg-bg-soft px-2.5 py-0.5 text-[13px]'>읽기 전용 {formReadOnly ? '켜짐' : '아님'}</span>
      </div>
      <p className='text-fg-2'>우선순위는 실제로 읽힌 배정 표의 쓸 수 있는 최소 순위 행 → 사람 위임 검수 풀 → 등록부 기본값입니다. 같은 최소 순위의 모델은 작업 분배 후보입니다.</p>
      {tableEffective && <p className='text-fg-2'>배정 표가 실제 출처이므로 사람 위임 검수 풀의 기존 값은 실행에 쓰지 않습니다. 다른 단계 풀 값은 유지됩니다.</p>}
      {data.saveBlocked && <p role='alert' className='text-warn'>설정 출처를 읽지 못해 저장할 수 없습니다. 새로고침한 뒤 다시 확인해 주세요. <Link href='/admin/models/assignments' prefetch={false} className='underline'>배정 상태 확인 →</Link></p>}
      {!data.saveBlocked && unknown && <p role='alert' className='text-warn'>현재 모델 선택이 유효하지 않습니다. 아래에서 모델을 다시 선택해 저장하세요. 활성화는 연결 확인 뒤 가능합니다.</p>}
      {data.tableOn && !unknown && !tableEffective && <p className='text-warn'>배정 표는 켜져 있지만 사람 확인에 쓸 수 있는 실전 행이 없어 풀/기본값을 씁니다. 표를 비었다고 저장하지 않습니다.</p>}
      {!data.tableOn && !unknown && <p className='small muted'>배정 표 읽기가 꺼져 있어 사람 위임 검수 풀과 등록부 기본값을 씁니다.</p>}
      {preview && <p className='text-fg-3'>읽기 전용 미리보기입니다. 저장 단추를 열지 않았습니다.</p>}
    </section>

    <section className='grid gap-2 rounded-xl border border-line bg-bg-card p-3'>
      <HumanReviewSwitch enabled={enabled} generation={generation} ready={ready}
        modelLabel={modelLabel} modelLocation={modelLocation} readOnly={preview} />
      <p><Link href='/admin/review?tab=human' prefetch={false} className='text-accent-ink underline'>사람 검토 큐 열기 →</Link></p>
    </section>

    <section className='grid gap-2 rounded-xl border border-line bg-bg-card p-3'>
      <h2 className='text-[15px] font-semibold'>사람 확인 · AI 위임 실제 모델</h2>
      {data.effectiveModels.length ? <ul className='grid gap-2'>
        {data.effectiveModels.map(model => {
          const probe = probeByKey.get(model.key);
          return <li key={model.key} className='grid gap-0.5 rounded-lg border border-line px-2.5 py-2'>
            <span><strong>{model.displayName}</strong> <code className='break-all'>{model.key}</code></span>
            <span className='text-fg-2'>공급자 {model.provider} · 장비 {model.equipment} · wire {model.model}</span>
            <span className={probe?.ready ? 'text-fg-2' : 'text-warn'}>{probe
              ? (probe.ready ? `GET /models 응답 확인 (${probe.ms}ms)` : `GET /models 연결 미확인 (${probe.ms}ms)`)
              : (preview ? '읽기 전용이라 연결 확인 생략' : unknown ? '출처 확인 불가로 연결 확인 생략' : '연결 확인 없음')}</span>
          </li>;
        })}
      </ul> : <p role='alert' className='text-warn'>확인된 사람 확인 · AI 위임 모델이 없습니다. 저장하지 말고 배정 표와 사람 위임 검수 풀을 확인해 주세요.</p>}
      <p className='text-[13px] text-fg-3'>GET /models는 연결 메타데이터만 확인합니다. 실제 추론 성공이나 실행 중 상태를 뜻하지 않습니다.</p>
    </section>

    {data.tableOn && <section className='grid gap-2 rounded-xl border border-line bg-bg-card p-3'>
      <h2 className='text-[15px] font-semibold'>사람 확인 · AI 위임 배정</h2>
      <p className='text-fg-2'>실전 배정은 다음 작업부터 읽습니다. 연결·계약·공유 한도를 통과해야 실제 호출합니다.</p>
      {data.saveBlocked && <p role='alert' className='text-warn'>배정 표를 읽지 못했습니다. 표가 비었다고 해석하지 않고 저장도 열지 않습니다.</p>}
      {!data.saveBlocked && data.assignments.length > 0 && data.assignments.map(row => {
        const initial: AssignmentFormValues = { assignmentId: row.assignmentId, version: row.version, stage: row.stage,
          deviceId: row.deviceId, registryKey: row.registryKey, transport: row.transport, rank: row.rank, vote: row.vote,
          mode: row.mode === 'live' ? 'live' : 'off', maxSlots: row.maxSlots, note: row.note };
        return <details key={row.assignmentId} className='rounded-lg border border-line px-2.5 py-2'>
          <summary>{row.rank}순위 · {row.deviceId} · {row.registryKey} · {row.mode === 'live' ? '실전' : '꺼짐'} · {row.role === 'primary' ? (formReadOnly ? '읽기 전용' : '편집') : '도우미'}</summary>
          {row.role === 'primary' ? <AssignmentForm options={data.options} initial={initial} readOnly={formReadOnly} />
            : <p className='small muted'>도우미 행은 도우미 장비 화면에서만 바꿉니다.</p>}
        </details>;
      })}
      {!data.saveBlocked && data.assignments.length === 0 && <p className='small muted'>배정 표에 사람 확인 · AI 위임 모델 행이 없습니다. 현재는 사람 위임 검수 풀 또는 등록부 기본값을 사용합니다.</p>}
      {!data.saveBlocked && !formReadOnly && <details className='rounded-lg border border-line px-2.5 py-2'>
        <summary className='text-button'>사람 확인 · AI 위임 배정 추가</summary>
        <AssignmentForm options={data.options} initial={null} prefill={{ stage: 'human' }} />
      </details>}
    </section>}

    <div>
      <span id='split-confirm' className='block scroll-mt-24' />
      <span id='split-tiebreak' className='block scroll-mt-24' />
      <span id='held-review-retry' className='block scroll-mt-24' />
      <StageModelPoolsForm pools={data.pools} models={data.models} defaults={data.defaults} version={data.version}
        stageIds={poolStageIds} readOnly={formReadOnly} />
    </div>
    <p className='text-[13px] text-fg-3'>저장된 작업 순위 설정은 사람 확인 모델 선택에 적용되지 않습니다. 위 단계 풀·배정 표·등록부 기본값만 사용합니다.</p>
  </div>;
}
