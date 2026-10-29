import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { GATEWAY_SERVING_CONTRACT_ROUTES } from "@/lib/llm/gateway-serving-contract-config";
import { envServingContracts, listAdminServingContracts } from "@/lib/operations/admin-serving-contracts";
import { secretBoxReady } from "@/lib/security/secret-box";
import { PageStamp } from "../../components/PageStamp";
import { ContractForm } from "./ContractForm";
import { DisableButton } from "./DisableButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "서빙 계약 — NoMoreVibe", robots: { index: false } };

/** Admin-managed serving contracts. A saved row replaces the env contract of the same route+model on every app within ~30 s. */
export default async function ServingContractsPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const [rows, env] = [await listAdminServingContracts(), envServingContracts()];
  const enabled = rows.filter(row => row.enabled);
  return <main className="mx-auto grid max-w-5xl gap-6 p-4">
    <PageStamp />
    <header className="grid gap-1">
      <Link href="/admin/models" className="text-[13px] text-fg-3">← 단계별 모델</Link>
      <h1 className="text-[22px] font-semibold">서빙 계약</h1>
      <p className="text-[13px] text-fg-3">모델을 어디로(주소) 어떻게(응답 모델·토큰 한도·인증) 부르는지의 계약입니다. 저장하면 배포 없이 각 앱이 30초 안에 다음 작업부터 씁니다.
        같은 경로·모델의 env 계약을 대신하며, 끄면 env 계약이 다시 쓰입니다. 용량 경로(정책)는 따로 있어야 실제로 호출됩니다.</p>
      {!secretBoxReady() && <p className="text-[13px]">이 서버에는 키 암호화 설정이 없어 「키 저장」 방식은 쓸 수 없습니다.</p>}
    </header>
    <section className="grid gap-2">
      <h2 className="text-[18px] font-semibold">켜진 관리 계약 ({enabled.length})</h2>
      <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[13px]"><thead><tr className="border-b border-line">
        <th className="py-2 pr-3">경로 · 모델</th><th className="py-2 pr-3">주소</th><th className="py-2 pr-3">인증</th><th className="py-2 pr-3">변경</th><th className="py-2" /></tr></thead>
        <tbody>{enabled.map(row => <tr key={row.id} className="border-b border-line align-top">
          <td className="py-2 pr-3">{row.routeId}<br /><code>{row.model}</code></td>
          <td className="py-2 pr-3"><code>{String(row.contract.endpoint ?? "")}</code></td>
          <td className="py-2 pr-3">{row.auth === "stored" ? `저장 키${row.hasKey ? "" : " (없음)"}` : row.auth === "none" ? "키 없음" : "게이트웨이 키"}</td>
          <td className="py-2 pr-3">{row.updatedBy}<br />{row.updatedAt.slice(0, 16).replace("T", " ")} · {row.contractHash.slice(0, 12)}</td>
          <td className="py-2"><DisableButton routeId={row.routeId} model={row.model} /></td></tr>)}</tbody></table></div>
    </section>
    <section className="grid gap-2">
      <h2 className="text-[18px] font-semibold">계약 추가·수정</h2>
      <ContractForm routes={GATEWAY_SERVING_CONTRACT_ROUTES} />
    </section>
    <details className="rounded-xl border border-line bg-bg-card p-5">
      <summary className="cursor-pointer text-[16px] font-semibold">env 계약 (읽기 전용, {env.length})</summary>
      <p className="my-2 text-[13px] text-fg-3">앱 시작 때 읽은 ABCLLM_SERVING_CONTRACTS입니다. 같은 경로·모델의 관리 계약이 켜지면 그것이 대신합니다.</p>
      <pre className="overflow-x-auto text-[13px]">{JSON.stringify(env, null, 2)}</pre>
    </details>
  </main>;
}
