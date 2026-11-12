import Link from "next/link";
import { formatCount } from "@/lib/operations/console-tasks";
import { MODEL_ADD_HREF, modelHref, modelMaxTokens, type ModelConsoleRow, type ModelStageRecommendation } from "@/lib/operations/model-console";
import { RereadModelsButton } from "../tasks/ConnectionButtons";
import { ModelAddStepOneForm, ModelAddStepTwoForm } from "./ModelAddForms";
import "../console/model-console.css";

export type ModelAddStep = 1 | 2 | 3;
const STEPS: readonly [ModelAddStep, string][] = [[1, "넣기"], [2, "이름과 한도"], [3, "쓸 단계"]];

/**
 * 모델 추가 세 걸음(2026-11-12 최종 시안 흐름 3, 조각 3a).
 * ① 넣기 — API 주소+키 또는 CLI → 기존 연결 저장(saveAiConnectionAction)이 만들면서 GET /models 로 응답·모델을 확인한다. 못 읽으면 「다시 읽기」(기존).
 * ② 이름과 한도 — 이름 · 장비 · 동시 한도 · 최대 토큰을 기존 연결 저장으로, 「한 번 불러 보기」는 기존 선택 모델 응답 시험(/api/admin/models/selected-probe).
 * ③ 쓸 단계 — 홈 「쌓임」과 같은 계산(지금 속도로 며칠)으로 오래 밀린 단계부터 권한다. 고르면 그 단계의 표본 비교(지원하는 작업) 또는 작업 배정으로.
 *    「나중에」면 홈의 「정리」(쓰는 단계 없는 모델)에 남는다 — 그 규칙은 이미 있다.
 * 순위·장비 행은 이 세 걸음에서 만들지 않는다 — 단계에 붙일 때(작업 배정 저장) 만들어진다.
 */
export function ModelAddFlow({ step, row, missing, recommendations, secretBox, readOnly, taken }: {
  step: ModelAddStep; row: ModelConsoleRow | null; missing: boolean; recommendations: readonly ModelStageRecommendation[]; secretBox: boolean; readOnly: boolean;
  taken: readonly string[];
}) {
  const connection = row?.connection ?? null;
  const found = connection ? row!.served.length : 0;
  return <div className="model-console">
    <div className="mc-head"><h2>모델 추가</h2><span className="mc-count">세 걸음 · 단계에 붙이기 전까지 처리에는 영향이 없습니다</span>
      <span className="mc-right"><Link prefetch={false} className="text-button" href="/admin/models">모델 목록</Link></span></div>
    <ol className="mc-steps" aria-label="모델 추가 걸음">{STEPS.map(([number, label]) => <li key={number} aria-current={number === step ? "step" : undefined}>
      <b>{number}</b>{label}</li>)}</ol>
    {missing && <p role="alert" className="mc-notice">넣은 모델을 찾지 못했습니다(지워졌거나 목록을 읽지 못함). 처음부터 다시 넣으세요.</p>}
    {step === 1 && <section className="mc-card" aria-label="넣기">
      <p className="mc-muted">OpenAI 호환 API 주소(…/v1)와 키, 또는 CLI 도구를 넣습니다. 넣으면 서버에 물어 응답과 모델을 확인합니다. OpenCode 는 호스트 설정이 있어
        <Link prefetch={false} href="/admin/models/llm?add=1#connection-new"> LLM 운영의 연결 추가</Link>에서 넣습니다.</p>
      <ModelAddStepOneForm secretBox={secretBox} readOnly={readOnly} taken={taken} />
    </section>}
    {step >= 2 && connection && <section className="mc-card" aria-label="넣은 것">
      <span className="mc-lab">① 넣기</span>
      <dl className="mc-dl">
        <dt>방식</dt><dd>{connection.kind === "api" ? "API 주소" : "CLI 도구"}</dd>
        {connection.host && <><dt>주소</dt><dd className="num">{connection.host}</dd></>}
        {connection.kind === "api" && <><dt>키</dt><dd>{connection.hasKey ? "저장됨" : "없음"}</dd></>}
        <dt>확인</dt><dd>{connection.kind === "cli" ? `CLI 모델 ${formatCount(connection.cliModels.length)}개 적음(CLI 에는 목록이 없습니다)`
          : connection.modelsError ? `응답 확인 실패(${connection.modelsError})` : connection.models ? `응답 정상 · 모델 ${formatCount(found)}개 찾음` : "아직 확인하지 않음"}</dd>
      </dl>
      {connection.kind === "api" && (connection.modelsError || !connection.models) && !readOnly && <div className="mc-acts"><RereadModelsButton id={connection.id} /></div>}
    </section>}
    {step === 2 && row && <section className="mc-card" aria-label="이름과 한도">
      <span className="mc-lab">② 이름과 한도</span>
      <ModelAddStepTwoForm row={row} maxTokens={modelMaxTokens(row.connection)} readOnly={readOnly} taken={taken.filter(name => name !== row.connection.label && name !== row.name)} />
    </section>}
    {step === 3 && row && <section className="mc-card" aria-label="쓸 단계">
      <span className="mc-lab">③ 쓸 단계 — {row.name}</span>
      {recommendations.length ? <form method="get" action="/admin/models/compare" className="mc-form">
        <input type="hidden" name="candidate" value={row.id} />
        {row.models[0] && <input type="hidden" name="model" value={row.models[0]} />}
        <ul className="mc-pick">{recommendations.map((item, index) => <li key={item.task}><label>
          <input type="radio" name="task" value={item.task} defaultChecked={index === 0} /><span>{item.label}<span className="mc-muted"> · {item.fact}</span></span>
          <span>{item.daysText}{item.compare ? "" : " · 비교 지원 안 함"}</span></label></li>)}</ul>
        <p className="mc-hint">밀린 단계부터 권합니다. 고르면 표본 비교로 이어집니다(지원 안 하는 단계는 비교 화면에서 작업 배정으로 바로 갑니다).
          「나중에」를 고르면 홈의 「정리」에 「아직 안 씁니다」로 남습니다.</p>
        <div className="mc-acts"><button type="submit" className="button small primary">표본 비교로</button>
          <Link prefetch={false} className="button small" href="/admin/flow">나중에</Link>
          <Link prefetch={false} className="text-button" href={modelHref(row.id)}>모델 상세</Link></div>
      </form> : <>
        <p className="mc-muted">지금 속도로 3일 넘게 밀린 단계 가운데 이 모델을 받을 수 있는 단계가 없습니다(또는 쌓임을 셀 수 없음).</p>
        <div className="mc-acts"><Link prefetch={false} className="button small primary" href="/admin/models/tasks">작업 배정에서 고르기</Link>
          <Link prefetch={false} className="button small" href="/admin/flow">나중에</Link></div>
      </>}
    </section>}
    {step > 1 && !row && !missing && <p className="mc-notice"><Link prefetch={false} href={MODEL_ADD_HREF}>처음부터 넣기</Link></p>}
  </div>;
}
