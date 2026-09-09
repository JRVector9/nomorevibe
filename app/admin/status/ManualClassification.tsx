'use client';
import { useState, useTransition } from 'react';
import { CATEGORIES } from '@/lib/domain/products/categories';
import type { manualCandidates } from '@/lib/operations/categories';
import { saveManualCategory } from './actions';

export function ManualClassification({ candidates }: { candidates: Awaited<ReturnType<typeof manualCandidates>> }) {
  const [selected, setSelected] = useState(candidates[0]?.repo ?? '');
  const [category, setCategory] = useState(candidates[0]?.category ?? '');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [pending, start] = useTransition();
  const [search, setSearch] = useState('');
  const candidate = candidates.find(c => c.repo === selected);
  return <>
    <section className="ops-panel">
      <h2>수동 카테고리 지정</h2>
      <p>AI 분류가 멈춰도 관리자가 승인 후보의 분류를 지정할 수 있습니다. 저장하면 퍼블리셔가 출처·심사·중복·차단 조건을 다시 확인합니다.</p>
      <p>승인 후보 최대 50건 표시 · 발행 완료·제외된 항목은 이 목록에 포함되지 않습니다.</p>
    </section>
    <div className="ops-manual-grid">
      <section className="ops-panel">
        <label htmlFor="manual-search">후보 검색</label>
        <input id="manual-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="프로젝트명 또는 저장소" />
        <div className="ops-candidate-list">
          {candidates.filter(c => (c.repo + ' ' + c.name).toLowerCase().includes(search.toLowerCase())).map(c =>
            <button key={c.repo} aria-pressed={selected === c.repo} onClick={() => {
              setSelected(c.repo); setCategory(c.category ?? ''); setReason(''); setMessage('');
            }}>
              <strong>{c.name}</strong><small>{c.repo}</small><span>{c.category ?? '분류 대기'}</span>
            </button>)}
        </div>
        {!candidates.length && <p>현재 분류할 승인 후보가 없습니다.</p>}
      </section>
      <section className="ops-panel">
        {candidate ? <>
          <div className="ops-eyebrow">PUBLICATION REVIEW</div><h2>{candidate.name}</h2>
          <p><a href={`https://github.com/${candidate.repo}`} target="_blank" rel="noreferrer noopener">{candidate.repo} ↗</a></p>
          <p>{candidate.url && /^https?:\/\//.test(candidate.url) && <a href={candidate.url} target="_blank" rel="noreferrer noopener">서비스 방문 ↗</a>}</p>
          <p>{candidate.description || '수집된 소개가 없습니다.'}</p>
          <div className="ops-note">{candidate.reason}</div>
          <label htmlFor="manual-category">카테고리</label>
          <select id="manual-category" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">카테고리 선택</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
          <label htmlFor="manual-reason">지정 사유</label>
          <textarea id="manual-reason" value={reason} maxLength={500} onChange={e => setReason(e.target.value)} placeholder="확인한 기능과 분류 이유를 입력해주세요." />
          <button className="primary" disabled={pending || !category || reason.trim().length < 3} onClick={() => start(async () => {
            const result = await saveManualCategory({ repo: candidate.repo, sourceHash: candidate.sourceHash, category, reason });
            setMessage(result.error ?? result.message ?? '');
          })}>{pending ? '저장 중…' : '분류 저장·발행 검토 요청'}</button>
          <p role="status">{message}</p>
        </> : <p>왼쪽에서 후보를 선택해주세요.</p>}
      </section>
    </div>
  </>;
}
