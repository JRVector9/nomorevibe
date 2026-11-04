import { modelRequestName, readModelRegistry, type ModelEnvironment } from "@/lib/llm/model-registry";

/** Server-rendered configuration only. Registration is separate from worker/readback readiness. */
export function ModelRegistryTable({ env = process.env }: { env?: ModelEnvironment }) {
  const registry = readModelRegistry(env);
  return <details className="rounded-xl border border-line bg-bg-card p-5">
    <summary className="cursor-pointer text-[18px] font-semibold">등록된 모델 설정</summary>
    <p className="my-3 text-[13px] text-fg-3">장비별 고유 키로 모델을 구분합니다. 웹 프로세스의 등록값이며, 실제 호출 권한·동시 실행 상한은 운영센터의 검증 계약과 용량 정책도 충족해야 합니다.</p>
    <p className="mb-2 text-[13px] text-fg-3 sm:hidden">표를 좌우로 밀어 모든 설정을 확인하세요.</p>
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="등록된 모델 설정 표">
      <table className="w-full min-w-[800px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className="py-2 pr-4">모델 · 고유 키</th><th className="py-2 pr-4">제공자 · 주소</th><th className="py-2 pr-4">요청 모델</th>
        <th className="py-2 pr-4">출력 토큰 상한</th><th className="py-2">동시 실행 상한</th>
      </tr></thead><tbody>{registry.models.map(model => <tr key={model.key} className="border-b border-line align-top">
        <th className="py-3 pr-4 font-normal"><span className="block font-semibold">{model.displayName}</span><code className="break-all text-fg-3">{model.key}</code></th>
        <td className="py-3 pr-4"><span className="block">{model.provider}</span><code className="break-all text-fg-3">{model.baseUrl ?? "CLI"}</code></td>
        <td className="py-3 pr-4"><code className="break-all">{modelRequestName(model)}</code></td>
        <td className="py-3 pr-4 font-mono tabular-nums">{model.maxTokens.toLocaleString("ko-KR")}</td>
        <td className="py-3 font-mono tabular-nums">{model.concurrency}</td>
      </tr>)}</tbody></table>
    </div>
    <p className="mt-3 text-[13px] text-fg-3">단계별 출력·동시 실행 예산은 등록된 모델 상한 안에서 적용합니다. 기존 개별 환경변수 설정은 위 단계별 표에 반영됩니다. 기한은 레지스트리의 모델·용도별 예산을 따르며, 선언된 사다리는 로드 시 순서를 검증합니다. 서버에서 실제로 강제하는지는 별도 검증이 필요합니다.</p>
    {registry.models.some(model => model.gatewayLabel || model.baseUrl?.includes("abcllm-api.brut.bot")) && <p className="mt-2 text-[13px] text-fg-3">요청 이름 앞의 대괄호(예: [m1])는 등록부 장비 표지이고, 주소 abcllm-api.brut.bot 은 퇴역한 예전 코드 기본값입니다. 그 주소만으로는 호출이 열리지 않습니다. 열리는 계약은 「모델 연결」의 직접 연결 행입니다.</p>}
  </details>;
}
