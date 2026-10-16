import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PipelineControlStatus } from '@/app/(operator)/admin/status/PipelineControlStatus';
import { buildPipelineControlStatus, type PipelineControlStatus as Snapshot } from '@/lib/operations/pipeline-control-status';
const render = (status: Snapshot) => renderToStaticMarkup(createElement(PipelineControlStatus, { status }));
describe('pipeline control status UI', () => {
  it('has an explicit unknown state', () => {
    expect(render(buildPipelineControlStatus(null, null))).toContain('미확인');
  });
  it('shows controls, epochs and charges with no activation actions or readiness claim from installation', () => {
    const status = buildPipelineControlStatus(null, null);
    status.observedAt = '2026-10-16T12:00:00.000Z';
    status.controls[2] = { key: 'model', label: '공통 모델 슬롯', mode: 'draining', epoch: 17, revision: 3,
      policy: 'verified', metrics: [{ label: '미정산', value: 5 }], note: '장부 값' };
    status.stages[2] = { stage: 'ai2', mode: 'items', epoch: 8, contract: 1, live: 2, unsettled: 3 };
    status.owners = [{ role: 'official-news', instanceId: 'oracle-news', host: 'oracle-osaka-smoke', release: 'release-one', epoch: 9, live: true }];
    const html = render(status);
    expect(html).toContain('드레인 중');
    expect(html).toContain('17');
    expect(html).toContain('미정산');
    expect(html).toContain('5');
    expect(html).toContain('oracle-news');
    expect(html).toContain('모델 제공용량 C');
    expect(html).toContain('실측 처리율 R');
    expect(html).toContain('Oracle 실행·장애복구');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('활성화 완료');
  });
  it('does not show missing readings as zero or healthy 0/0', () => {
    const html = render(buildPipelineControlStatus(null, null));
    expect(html).toContain('조회 시각 미확인');
    expect(html).toContain('자료 없음');
    expect(html).not.toContain('0/0');
    expect(html).not.toContain('>0<');
  });
});
