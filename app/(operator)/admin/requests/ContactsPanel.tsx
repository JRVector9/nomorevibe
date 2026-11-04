import Link from "next/link";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";
import { contactLabels, contactStates } from "@/lib/operations/admin-requests-contract";
import { readRequestSection } from "@/lib/operations/admin-request-workspace";
import { contactRequestQueue } from "@/lib/operations/contact-requests";
import { formatDetailTime } from "@/lib/format/time";
import { ContactCreateForm, ContactUpdateForm } from "./RequestForms";
import { ReadUnavailable } from "./WorkspaceParts";

export async function ContactsPanel({ params, admin, secret }: {
  params: Record<string, string | string[] | undefined>; admin: { login: string; exp: number }; secret: string;
}) {
  const state = typeof params.state === "string" && (["open", "all", ...contactStates] as string[]).includes(params.state)
    ? params.state as "open" | "all" | typeof contactStates[number] : "open";
  const parsedOffset = typeof params.offset === "string" ? Number(params.offset) : 0;
  const offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? Math.min(parsedOffset, 100000) : 0;
  const result = await readRequestSection("contacts", () => contactRequestQueue({ state, offset }));
  const csrf = { csrfToken: adminRequestToken("contact-requests", admin, secret), expiresAt: admin.exp };
  return <div className="rw-stack">
    <div className="rw-note">contact@nomorevibe.com으로 받은 메일을 수동으로 기록합니다. 외부 메일함을 자동으로 읽거나 메일을 보내지 않습니다. 회신은 기존 메일함에서 보내고 처리 상태를 저장하세요.</div>
    <details className="rw-panel"><summary>받은 문의 수동 접수</summary><div className="rw-panel-body"><ContactCreateForm {...csrf} /></div></details>
    <form action="/admin/requests" className="rw-toolbar">
      <input type="hidden" name="tab" value="contact" />
      <label>상태 <select name="state" defaultValue={state}>
        <option value="open">열린 문의</option><option value="all">전체</option>
        {Object.entries(contactLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label><button className="rw-button">조회</button>
      {result.ok && <span className="rw-count">문의 {result.data.count.toLocaleString("ko-KR")}건 · 수신 시각이 오래된 것부터</span>}
    </form>
    {!result.ok ? <ReadUnavailable title="문의" /> : <>
      {result.data.items.map(item => <section key={`${item.id}-${item.version}`} id={`contact-${item.id}`} className="rw-panel rw-contact">
        <header className="rw-panel-head"><h2>{item.subject}</h2><span className="rw-state">{contactLabels[item.status]}</span></header>
        <div className="rw-panel-body rw-stack">
          <p className="rw-meta break-all">{item.senderEmail} · 수신 {formatDetailTime(item.receivedAt)}</p>
          <p className="rw-original">{item.body}</p>
          <p className="rw-meta">접수 {item.createdBy} · 최근 처리 {item.updatedBy} · {formatDetailTime(item.updatedAt)} · 원본 판 {item.version}</p>
          <ContactUpdateForm {...csrf} id={item.id} version={item.version} status={item.status} handlingNote={item.handlingNote} />
        </div>
      </section>)}
      {!result.data.items.length && <p className="rw-empty">조건에 맞는 문의가 없습니다.</p>}
      {result.data.nextOffset !== null && <Link prefetch={false} href={`/admin/requests?tab=contact&state=${state}&offset=${result.data.nextOffset}`} className="rw-button rw-next">다음 문의</Link>}
    </>}
  </div>;
}
