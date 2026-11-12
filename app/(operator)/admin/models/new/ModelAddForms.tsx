"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkModelAddStepOne, checkModelAddStepTwo, connectionFormEntries, deviceRowFormEntries, MODEL_CONSOLE_LIMITS, type ModelAddKind, type ModelConsoleRow } from "@/lib/operations/model-console";
import { saveAiConnectionAction } from "../tasks/actions";
import { saveDeviceRowAction } from "../devices/actions";
import { SelectedModelProbe } from "../SelectedModelProbe";

const step = (id: string, number: 2 | 3) => `/admin/models/new?id=${encodeURIComponent(id)}&step=${number}`;

/**
 * ① 넣기 — 검사(checkModelAddStepOne) 뒤 기존 연결 저장(saveAiConnectionAction)으로 연결을 만든다. API 는 저장하면서 GET /models 를 읽는다.
 * 이름은 주소의 호스트에서 임시로 만들고(겹치면 번호), 두 번째 걸음에서 사용자가 정한다. 만든 연결은 순위가 없어 처리에 쓰이지 않는다.
 */
export function ModelAddStepOneForm({ secretBox, readOnly, taken }: { secretBox: boolean; readOnly: boolean; taken: readonly string[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<ModelAddKind>("api");
  const [baseUrl, setBaseUrl] = useState(""), [apiKey, setApiKey] = useState("");
  const [cliTool, setCliTool] = useState("claude"), [cliModels, setCliModels] = useState(""), [cliVersion, setCliVersion] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const submit = () => {
    const checked = checkModelAddStepOne({ kind, baseUrl, cliTool, cliModels }, taken);
    setIssues(checked.issues);
    if (checked.issues.length) return;
    start(async () => {
      const form = new FormData();
      const fields: [string, string][] = [["label", checked.label], ["kind", kind], ["deviceId", checked.deviceId], ["capacitySlots", "1"], ["enabled", "1"]];
      if (kind === "api") fields.push(["baseUrl", checked.baseUrl ?? ""], ["apiKey", apiKey.trim()]);
      else fields.push(["cliTool", cliTool], ["cliModels", cliModels], ["cliVersion", cliVersion]);
      for (const [name, value] of fields) form.append(name, value);
      const saved = await saveAiConnectionAction(null, form);
      if (!saved?.ok || !saved.connectionId) { setIssues(saved?.issues ?? ["저장 결과를 확인하지 못했습니다."]); return; }
      router.push(step(saved.connectionId, 2));
    });
  };
  return <form className="mc-form" data-dirty={baseUrl || apiKey || cliModels ? "true" : undefined} onSubmit={event => { event.preventDefault(); submit(); }}>
    <fieldset><legend>방식</legend><div className="mc-acts">
      <label><input type="radio" name="kind" checked={kind === "api"} onChange={() => setKind("api")} /> API 주소</label>
      <label><input type="radio" name="kind" checked={kind === "cli"} onChange={() => setKind("cli")} /> CLI 도구</label></div></fieldset>
    {kind === "api" ? <>
      <label><span>주소</span><input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://호스트/v1" autoComplete="off" /></label>
      <label><span>키</span><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={!secretBox} autoComplete="off"
        placeholder={secretBox ? "없으면 비워 둡니다" : "이 서버에는 키 암호화 설정이 없습니다"} /></label>
    </> : <>
      <label><span>도구</span><select value={cliTool} onChange={event => setCliTool(event.target.value)}>
        <option value="claude">Claude</option><option value="codex">Codex</option><option value="grok">Grok</option></select></label>
      <label><span>모델 이름</span><input type="text" value={cliModels} onChange={event => setCliModels(event.target.value)} placeholder="sonnet (띄어쓰기로 여럿)" autoComplete="off" /></label>
      <label><span>CLI 버전</span><input type="text" value={cliVersion} onChange={event => setCliVersion(event.target.value)} placeholder="워커의 --version 출력(나중에 적어도 됨)" autoComplete="off" /></label>
    </>}
    <div className="mc-acts"><button type="submit" className="button small primary" disabled={readOnly || pending}>{pending ? "응답 확인 중…" : "넣고 응답 확인"}</button></div>
    {issues.map(text => <p key={text} role="alert" className="mc-msg">{text}</p>)}
  </form>;
}

/**
 * ② 이름과 한도 — 이름(사용자가 정한 이름 하나) · 장비(묶음 이름) · 동시 한도 · 최대 토큰을 기존 연결 저장으로. 장비 행이 아직 없으면 같은 동시 한도로
 * 기존 장비 한 줄 저장(saveDeviceRowAction — 행이 없으면 첫 행을 만든다, 감사)도 부른다 — 「한 번 불러 보기」(기존 선택 모델 응답 시험)가 장비 칸을 확인하기 때문이다.
 * 저장한 뒤 시험 호출과 「다음」이 열린다.
 */
export function ModelAddStepTwoForm({ row, maxTokens, readOnly, taken }: { row: ModelConsoleRow; maxTokens: number | null; readOnly: boolean; taken: readonly string[] }) {
  const router = useRouter();
  const { connection } = row;
  const [name, setName] = useState(row.name), [machine, setMachine] = useState(row.machine);
  const [limit, setLimit] = useState(String(row.limit)), [tokens, setTokens] = useState(connection.contextTokens ? String(connection.contextTokens) : "");
  const [issues, setIssues] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const model = row.models[0] ?? null;
  const hasDevice = row.limitSource !== "connection";
  const submit = () => {
    const found = checkModelAddStepTwo({ name, machine, limit, maxTokens: tokens }, taken, connection.kind);
    setIssues(found); setSaved(null);
    if (found.length) return;
    start(async () => {
      const form = new FormData();
      for (const [field, value] of connectionFormEntries(connection, { name, machine, limit: Number(limit),
        ...(connection.kind === "api" ? { maxTokens: tokens.trim() ? Number(tokens.replace(/,/g, "")) : null } : {}) })) form.append(field, value);
      const result = await saveAiConnectionAction(null, form);
      if (!result?.ok) { setIssues(result?.issues ?? ["저장 결과를 확인하지 못했습니다."]); router.refresh(); return; }
      const notes = [result.message ?? "저장했습니다."];
      if (!hasDevice) {
        const device = new FormData();
        for (const [field, value] of deviceRowFormEntries({ deviceId: row.deviceId, expectedVersion: null, limitSlots: Number(limit), modelLimits: null })) device.append(field, value);
        const made = await saveDeviceRowAction(null, device);
        if (made?.ok) notes.push(`장비 ${row.deviceId}: ${made.message ?? "만들었습니다."}`);
        else setIssues((made?.issues ?? ["장비 칸을 만들지 못했습니다."]).map(text => `연결은 저장했지만 장비 칸은 만들지 못했습니다: ${text}`));
      }
      setSaved(notes.join(" "));
      router.refresh();
    });
  };
  return <form className="mc-form" data-dirty={saved ? undefined : "true"} onSubmit={event => { event.preventDefault(); submit(); }}>
    <label><span>이름</span><input type="text" value={name} maxLength={80} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
    <label><span>장비</span><input type="text" value={machine} maxLength={80} onChange={event => setMachine(event.target.value)} placeholder={row.deviceId} autoComplete="off" /></label>
    <label><span>동시 한도</span><input className="num" type="number" min={1} max={MODEL_CONSOLE_LIMITS.limitMax} value={limit} onChange={event => setLimit(event.target.value)} /></label>
    {connection.kind === "api" && <label><span>최대 토큰</span><input className="num" type="number" min={1} value={tokens} onChange={event => setTokens(event.target.value)}
      placeholder={maxTokens ? `서버가 알려 준 값 ${maxTokens.toLocaleString("ko-KR")}` : "서버가 알려 주지 않으면 적습니다"} /></label>}
    <p className="mc-hint">이름은 관리자 화면 어디서나 이 모델을 부르는 이름입니다. 서버가 알려 준 모델 이름은 상세의 「연결 확인」에만 보입니다.</p>
    <div className="mc-acts"><button type="submit" className="button small primary" disabled={readOnly || pending}>{pending ? "저장 중…" : "저장"}</button>
      <Link prefetch={false} className="button small" href={step(connection.id, 3)} aria-disabled={!hasDevice && !saved ? "true" : undefined}>다음: 쓸 단계</Link></div>
    <label><span>시험 호출</span><span>{model && hasDevice ? <SelectedModelProbe choice={{ provider: connection.id, model }} disabled={readOnly} />
      : <span className="mc-muted">{model ? "저장하면 장비 칸이 생겨 한 번 불러 볼 수 있습니다." : "부를 모델이 없습니다 — 첫 걸음의 확인을 다시 하세요."}</span>}</span></label>
    {saved && <p role="status" className="mc-msg">{saved}</p>}
    {issues.map(text => <p key={text} role="alert" className="mc-msg">{text}</p>)}
  </form>;
}
