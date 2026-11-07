import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { GATEWAY_SERVING_CONTRACT_ROUTES } from "@/lib/llm/gateway-serving-contract-config";
import { readModelRegistry, modelRequestName } from "@/lib/llm/model-registry";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { ENGINE_CONNECT_ROUTES } from "@/lib/operations/admin-engine-connect";
import { listAdminRegistryOverrides } from "@/lib/operations/admin-model-registry";
import { listAdminServingContracts } from "@/lib/operations/admin-serving-contracts";
import { secretBoxReady } from "@/lib/security/secret-box";
import { PageStamp } from "../../components/PageStamp";
import { modelsAdvancedEditor } from "../../workspace-navigation";
import { AdvancedEditorLinks, advancedEditorTitle } from "../advanced/AdvancedEditorLinks";
import { ModelRegistryTable } from "../ModelRegistryTable";
import { ContractForm } from "./ContractForm";
import { DisableButton } from "./DisableButton";
import { EngineConnectForm } from "./EngineConnectForm";
import { RegistryOverrideForm, RevertRegistryButton } from "./RegistryOverrideForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: advancedEditorTitle("contracts"), robots: { index: false } };
const EDITOR = modelsAdvancedEditor("contracts");

/** Admin-managed serving contracts — the only contract source. A saved row applies on every app within ~30 s. */
export default async function ServingContractsPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  await ensureServingContracts(0);
  const [rows, overrides] = [await listAdminServingContracts(), await listAdminRegistryOverrides()];
  const enabled = rows.filter(row => row.enabled), overridden = overrides.filter(row => row.enabled);
  const registry = readModelRegistry().models;
  const connectable = registry.filter(model => model.provider === "abcllm").map(model => ({ key: model.key, label: model.displayName,
    requestModel: modelRequestName(model), baseUrl: model.baseUrl, purposes: [...model.purposes] }));
  return <main className="mx-auto grid max-w-5xl gap-6 p-4">
    <PageStamp />
    <header className="grid gap-1">
      <AdvancedEditorLinks />
      <h1 className="text-[22px] font-semibold">{EDITOR.label}</h1>
      <p className="text-[13px] text-fg-3">모델을 어디로(주소) 어떻게(응답 모델·토큰 한도·인증) 부르는지의 계약입니다. 저장하면 배포 없이 각 앱이 30초 안에 다음 작업부터 씁니다.
        계약은 여기 저장한 것만 쓰며, 끄면 그 경로·모델은 다시 저장할 때까지 호출하지 않습니다. 용량 경로(정책)는 따로 있어야 실제로 호출됩니다.
        abcLLM 게이트웨이는 제거됐으므로 엔진 직접 연결 계약만 호출됩니다.</p>
      {!secretBoxReady() && <p className="text-[13px]">이 서버에는 키 암호화 설정이 없어 「키 저장」 방식은 쓸 수 없습니다.</p>}
    </header>
    <section className="grid gap-2">
      <h2 className="text-[18px] font-semibold">엔진 연결 (주소·키·모델만)</h2>
      <p className="text-[13px] text-fg-3">고른 등록부 모델의 주소와 엔진 모델명을 바꾸고(abcLLM 이름표 없이), 고른 경로마다 엔진 직접 계약을 만듭니다.
        저장 전에 서버가 엔진의 모델 목록을 다시 읽어 모델과 최대 길이를 확인합니다. 용량 정책에 경로가 없으면 그 호출은 정책을 추가할 때까지 보류됩니다.</p>
      <EngineConnectForm models={connectable} routes={ENGINE_CONNECT_ROUTES} />
    </section>
    <section className="grid gap-2">
      <h2 className="text-[18px] font-semibold">켜진 관리 계약 ({enabled.length})</h2>
      <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className="py-2 pr-3">경로 · 모델</th><th className="py-2 pr-3">주소</th><th className="py-2 pr-3">인증</th><th className="py-2 pr-3">변경</th><th className="py-2" /></tr></thead>
        <tbody>{enabled.map(row => <tr key={row.id} className="border-b border-line align-top">
          <td className="py-2 pr-3">{row.routeId}<br /><code>{row.model}</code></td>
          <td className="py-2 pr-3"><code>{String(row.contract.endpoint ?? "")}</code></td>
          <td className="py-2 pr-3">{row.auth === "stored" ? `저장 키${row.hasKey ? "" : " (없음)"}` : row.auth === "none" ? "키 없음" : "호출 안 됨 — 키 없음 또는 저장 키로 다시 저장"}
            <br />{row.transport === "direct" ? "엔진 직접" : "호출 안 됨 — 직접 연결 계약이 필요합니다"}</td>
          <td className="py-2 pr-3">{row.updatedBy}<br />{row.updatedAt.slice(0, 16).replace("T", " ")} · {row.contractHash.slice(0, 12)}</td>
          <td className="py-2"><DisableButton routeId={row.routeId} model={row.model} /></td></tr>)}</tbody></table></div>
    </section>
    <section className="grid gap-2">
      <h2 className="text-[18px] font-semibold">계약 추가·수정</h2>
      <ContractForm routes={GATEWAY_SERVING_CONTRACT_ROUTES} />
    </section>
    <section className="grid gap-2">
      <h2 className="text-[18px] font-semibold">모델 등록부 덮어쓰기 ({overridden.length})</h2>
      <p className="text-[13px] text-fg-3">코드 기본 정의 대신 쓰는 정의입니다. 되돌리면 코드 기본값이 다시 쓰입니다.
        요청 이름 앞의 대괄호는 장비 표지이고, 주소가 abcllm-api.brut.bot 이면 퇴역한 예전 코드 기본 주소입니다. 그 주소만으로는 호출이 열리지 않습니다. 열리는 것은 위의 직접 연결 계약입니다.</p>
      {overridden.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className="py-2 pr-3">키</th><th className="py-2 pr-3">요청 모델 · 주소</th><th className="py-2 pr-3">변경</th><th className="py-2" /></tr></thead>
        <tbody>{overridden.map(row => <tr key={row.id} className="border-b border-line align-top">
          <td className="py-2 pr-3"><code>{row.key}</code></td>
          <td className="py-2 pr-3"><code>{row.definition.gatewayLabel ? `[${String(row.definition.gatewayLabel)}] ` : ""}{String(row.definition.model ?? "")}</code><br /><code>{String(row.definition.baseUrl ?? "")}</code></td>
          <td className="py-2 pr-3">{row.updatedBy}<br />{row.updatedAt.slice(0, 16).replace("T", " ")}</td>
          <td className="py-2"><RevertRegistryButton registryKey={row.key} /></td></tr>)}</tbody></table></div>}
      <RegistryOverrideForm definitions={registry.map(model => ({ ...model }))} />
      {/* 등록부 전체(읽기 전용) — 옛 LLM 운영 「참고」 접힘에서 옮겼다(PR 5). 덮어쓰기를 반영한 지금 등록부다 */}
      <ModelRegistryTable />
    </section>
  </main>;
}
