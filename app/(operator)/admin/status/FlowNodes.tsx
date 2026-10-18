'use client';
import { useSearchParams } from 'next/navigation';

export type FlowLane = { key: string; label: string; heading: React.ReactNode; className: string;
  nodes: { key: string; tone?: 'ok' | 'warn' | 'bad'; card: React.ReactNode }[] };

/**
 * 흐름 상세의 노드 줄 — 노드를 누르면 그 노드의 상세(처리 지표 · 모델 · 미룬 이유)가 줄들 아래에 열린다.
 * 노드 카드와 상세는 서버가 그린 조각이고, 여기서는 어느 상세를 보일지만 고른다. 고른 노드는 주소(?node=)에 둔다 —
 * 탭·작업 상세처럼 뒤로 가기·새로고침·링크 공유에서 남는다(ADM-29). 서버 조회를 다시 돌리지 않게 replaceState 만 쓴다.
 */
export function FlowNodes({ lanes, details, initial }: { lanes: FlowLane[]; details: Record<string, React.ReactNode>; initial: string }) {
  const params = useSearchParams();
  const requested = params.get('node');
  const selected = requested && lanes.some(lane => lane.nodes.some(node => node.key === requested)) ? requested : initial;
  function pick(key: string) {
    const next = new URLSearchParams(params.toString());
    next.set('node', key);
    window.history.replaceState(null, '', `?${next.toString()}`);
  }
  return <>
    {lanes.map(lane => <section key={lane.key} className="ops-flow-lane" aria-label={lane.label}>
      {lane.heading}
      <div className={lane.className}>{lane.nodes.map(node => <button type="button" key={node.key} className="ops-flow-node" data-node={node.key}
        data-tone={node.tone} aria-pressed={selected === node.key} onClick={() => pick(node.key)}>{node.card}</button>)}</div>
    </section>)}
    <section className="ops-flow-panel" aria-live="polite">{details[selected]}</section>
  </>;
}
