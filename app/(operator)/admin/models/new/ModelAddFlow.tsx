import Link from "next/link";
import { formatCount } from "@/lib/operations/console-tasks";
import { MODEL_ADD_HREF, modelHref, modelMaxTokens, type ModelConsoleRow, type ModelStageRecommendation } from "@/lib/operations/model-console";
import { RereadModelsButton } from "../tasks/ConnectionButtons";
import { ModelAddStepOneForm, ModelAddStepTwoForm } from "./ModelAddForms";
import "../console/model-console.css";

export type ModelAddStep = 1 | 2 | 3;
const STEPS: readonly [ModelAddStep, string][] = [[1, "넣기"], [2, "이름과 한도"], [3, "쓸 단계"]];
export type ModelAddFlowProps = {
  step: ModelAddStep; row: ModelConsoleRow | null; missing: boolean; recommendations: readonly ModelStageRecommendation[]; secretBox: boolean; readOnly: boolean;
  taken: readonly string[]; embedded?: boolean;
  /** Drawer callbacks reuse the existing save actions and refresh the authoritative inventory. */
  drawer?: boolean; onCreated?: (connectionId: string) => void; onStep?: (step: ModelAddStep) => void;
  onReadAgain?: () => void; onAttachModel?: (connectionId: string) => void; onClose?: () => void;
};

/**
 * 모델 추가 세 단계(2026-11-12 최종 시안 흐름 3, 조각 3a · 「1인 운영 콘솔 시안」 화면 3 — 세 칸을 나란히).
 * ① 넣기 — API 주소+키 또는 CLI → 기존 연결 저장(saveAiConnectionAction)이 만들면서 GET /models 로 응답·모델을 확인한다. 못 읽으면 「다시 읽기」(기존).
 * ② 이름과 한도 — 이름 · 장비 · 동시 한도 · 최대 토큰을 기존 연결 저장으로, 「한 번 불러 보기」는 기존 선택 모델 응답 시험(/api/admin/models/selected-probe).
 * ③ 쓸 단계 — 홈 「쌓임」과 같은 계산(지금 속도로 며칠)으로 오래 밀린 단계부터 권한다. 고르면 그 단계의 표본 비교(지원하는 작업) 또는 작업 배정으로.
 *    「나중에」면 홈의 「정리」(쓰는 단계 없는 모델)에 남는다 — 그 규칙은 이미 있다.
 * 순위·장비 행은 이 세 걸음에서 만들지 않는다 — 단계에 붙일 때(작업 배정 저장) 만들어진다.
 */
export function ModelAddFlow({ step, row, missing, recommendations, secretBox, readOnly, taken, embedded = false,
  drawer = false, onCreated, onStep, onReadAgain, onAttachModel, onClose }: ModelAddFlowProps) {
  const connection = row?.connection ?? null;
  const found = connection ? row!.served.length : 0;
  const maxTokens = row ? modelMaxTokens(row.connection) : null;
  if (drawer) return <div id="model-add" className="mc-add-flow">
    <ol className="mc-add-steps" aria-label="모델 추가 단계">{([[1, "연결"], [2, "이름과 한도"], [3, "쓸 작업"]] as const).map(([number, label]) =>
      <li key={number} aria-current={step === number ? "step" : undefined} data-complete={step > number || undefined}>
        {number} {label}</li>)}</ol>
    {step === 1 ? <>
      <ModelAddStepOneForm secretBox={secretBox} readOnly={readOnly} taken={taken} onCreated={onCreated} drawer />
      <p className="mc-hint">OpenCode 는 <Link prefetch={false} href="/admin/models/llm?add=1#connection-new">LLM 운영의 연결 추가</Link>에서 넣습니다.</p>
    </> : !row ? <div className="mc-callout" role={missing ? "alert" : "status"}>
      <p>{missing ? "저장한 모델을 읽지 못했습니다. 목록을 다시 확인하세요." : "저장한 모델을 다시 읽는 중입니다."}</p>
      {onReadAgain && <button type="button" className="text-button" onClick={onReadAgain}>목록 다시 읽기</button>}
    </div> : step === 2 ? <>
      <div className="mc-callout">
        {connection!.kind === "cli" ? `CLI 모델 ${formatCount(connection!.cliModels.length)}개를 저장했습니다.`
          : connection!.modelsError ? `연결은 저장했지만 모델 목록 확인에 실패했습니다(${connection!.modelsError}).`
            : connection!.models ? `응답 정상 · 모델 ${formatCount(found)}개 찾음` : "연결은 저장했지만 모델 목록을 아직 확인하지 못했습니다."}
      </div>
      {connection!.kind === "api" && (connection!.modelsError || !connection!.models) && !readOnly && <RereadModelsButton id={row.id} />}
      <ModelAddStepTwoForm row={row} maxTokens={maxTokens} readOnly={readOnly}
        taken={taken.filter(name => name !== row.connection.label && name !== row.name)} onNext={onStep ? () => onStep(3) : undefined} />
    </> : <>
      <p className="mc-add-success"><span aria-hidden="true">✓</span> {row.name}을(를) 추가했습니다.</p>
      <p className="mc-drawer-lead">{row.stageCount ? `현재 ${formatCount(row.stageCount)}개 작업에 배정되어 있습니다.`
        : "아직 처리할 작업은 없습니다. 모델 상세에서 쓸 작업을 고르세요."}</p>
      <div className="mc-editor-foot"><button type="button" className="button" onClick={onClose}>나중에 붙이기</button>
        {onAttachModel ? <button type="button" className="button primary" onClick={() => onAttachModel(row.id)}>쓸 작업 고르기 →</button>
          : <Link prefetch={false} className="button primary" href={modelHref(row.id)}>쓸 작업 고르기 →</Link>}</div>
    </>}
  </div>;
  // 시안 화면 3 「모델 추가」 — 세 칸이 나란히 있고, 지금 단계 칸에서만 고친다. 지난 칸은 넣은 값, 다음 칸은 할 일을 적는다
  const state = (number: ModelAddStep) => number < step ? "done" : number === step ? "now" : "next";
  return <div className="model-console" id={embedded ? "model-add" : undefined}>
    <div className="mc-head">{embedded ? <h3>모델 추가</h3> : <h2>모델 추가</h2>}<span className="mc-count">세 단계 · 단계에 붙이기 전까지 처리에는 영향이 없습니다</span>
      {!embedded && <span className="mc-right"><Link prefetch={false} className="text-button" href="/admin/models">모델 목록</Link></span>}</div>
    {missing && <p role="alert" className="mc-notice">넣은 모델을 찾지 못했습니다(지워졌거나 목록을 읽지 못함). 처음부터 다시 넣으세요.</p>}
    <ol className="cs-steps" aria-label="모델 추가 단계">
      <li className="cs-step" data-state={state(1)} aria-current={step === 1 ? "step" : undefined} aria-label="넣기">
        <span className="cs-k">{STEPS[0][0]} {STEPS[0][1]}</span>
        {step === 1 && <>
          <p className="mc-muted">OpenAI 호환 API 주소(…/v1)와 키, 또는 CLI 도구를 넣습니다. 넣으면 서버에 물어 응답과 모델을 확인합니다. OpenCode 는 호스트 설정이 있어
            <Link prefetch={false} href="/admin/models/llm?add=1#connection-new"> LLM 운영의 연결 추가</Link>에서 넣습니다.</p>
          <ModelAddStepOneForm secretBox={secretBox} readOnly={readOnly} taken={taken} />
        </>}
        {step >= 2 && connection && <>
          <dl className="cs-f">
            <dt>방식</dt><dd>{connection.kind === "api" ? "API 주소" : "CLI 도구"}</dd>
            {connection.host && <><dt>주소</dt><dd className="num">{connection.host}</dd></>}
            {connection.kind === "api" && <><dt>키</dt><dd>{connection.hasKey ? "저장됨" : "없음"}</dd></>}
            <dt>확인</dt><dd className="t">{connection.kind === "cli" ? `CLI 모델 ${formatCount(connection.cliModels.length)}개 적음(CLI 에는 목록이 없습니다)`
              : connection.modelsError ? `응답 확인 실패(${connection.modelsError})` : connection.models ? `응답 정상 · 모델 ${formatCount(found)}개 찾음` : "아직 확인하지 않음"}</dd>
          </dl>
          {connection.kind === "api" && (connection.modelsError || !connection.models) && !readOnly && <div className="mc-acts"><RereadModelsButton id={connection.id} /></div>}
        </>}
      </li>
      <li className="cs-step" data-state={state(2)} aria-current={step === 2 ? "step" : undefined} aria-label="이름과 한도">
        <span className="cs-k">{STEPS[1][0]} {STEPS[1][1]}</span>
        {step === 2 && row && <ModelAddStepTwoForm row={row} maxTokens={maxTokens} readOnly={readOnly}
          taken={taken.filter(name => name !== row.connection.label && name !== row.name)} />}
        {step === 3 && row && <dl className="cs-f">
          <dt>이름</dt><dd>{row.name}</dd>
          <dt>장비</dt><dd>{row.machine}</dd>
          <dt>동시 한도</dt><dd className="num">{formatCount(row.limit)}</dd>
          {row.connection.kind === "api" && <><dt>최대 토큰</dt><dd className="num">{maxTokens === null ? "—" : formatCount(maxTokens)}</dd></>}
          <dt>고치기</dt><dd className="t"><Link prefetch={false} href={`${MODEL_ADD_HREF}?id=${encodeURIComponent(row.id)}&step=2`}>이름과 한도 고치기</Link></dd>
        </dl>}
        {step === 1 && <p className="mc-hint">이름(관리자 화면 어디서나 부르는 이름 하나) · 장비 · 동시 한도 · 최대 토큰을 정하고, 한 번 불러 봅니다.</p>}
      </li>
      <li className="cs-step" data-state={state(3)} aria-current={step === 3 ? "step" : undefined} aria-label="쓸 단계">
        <span className="cs-k">{STEPS[2][0]} {STEPS[2][1]}{step === 3 && row ? ` — ${row.name}` : ""}</span>
        {step === 3 && row ? recommendations.length ? <form method="get" action="/admin/models/compare" className="mc-form">
          <input type="hidden" name="candidate" value={row.id} />
          {row.models[0] && <input type="hidden" name="model" value={row.models[0]} />}
          <ul className="cs-pick">{recommendations.map((item, index) => <li key={item.task}><label title={item.fact}>
            <input type="radio" name="task" value={item.task} defaultChecked={index === 0} /><span>{item.label}</span>
            <span>{item.daysText}{item.compare ? "" : " · 비교 지원 안 함"}</span></label></li>)}</ul>
          <p className="mc-hint">밀린 단계부터 권합니다. 고르면 표본 비교로 이어집니다(지원 안 하는 단계는 비교 화면에서 작업 배정으로 바로 갑니다).
            「나중에」를 고르면 홈의 「정리」에 「아직 안 씁니다」로 남습니다.</p>
          <div className="mc-acts"><button type="submit" className="button small primary">표본 비교 뒤 붙이기</button>
            <Link prefetch={false} className="button small" href="/admin/flow">나중에</Link>
            <Link prefetch={false} className="text-button" href={modelHref(row.id)}>모델 상세</Link></div>
        </form> : <>
          <p className="mc-muted">지금 속도로 3일 넘게 밀린 단계 가운데 이 모델을 받을 수 있는 단계가 없습니다(또는 쌓임을 셀 수 없음).</p>
          <div className="mc-acts"><Link prefetch={false} className="button small primary" href="/admin/models#tasks">작업 배정에서 고르기</Link>
            <Link prefetch={false} className="button small" href="/admin/flow">나중에</Link></div>
        </> : <p className="mc-hint">밀린 단계부터 권합니다. 붙이기 전에 표본을 지금 모델과 나란히 돌려 결과를 비교합니다.</p>}
      </li>
    </ol>
    {step > 1 && !row && !missing && <p className="mc-notice"><Link prefetch={false} href={MODEL_ADD_HREF}>처음부터 넣기</Link></p>}
  </div>;
}
