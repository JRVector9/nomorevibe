import type { ReactNode } from "react";

export const n = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("ko-KR");
export function prototypeRepositoryStatus(value:string|null) {
  const labels:Record<string,string>={ok:"저장소 응답 확인",not_found:"저장소 없음",empty:"빈 저장소",blocked:"접근 제한"};
  return value ? labels[value]??"상태 확인 필요" : "미관측";
}
export function PrototypePanel({ title, children, actions, note }: { title: string; children: ReactNode; actions?: ReactNode; note?: string }) {
  return <section className="panel"><div className="panel-head"><div><h3>{title}</h3>{note && <p>{note}</p>}</div>{actions && <div className="right">{actions}</div>}</div><div className="panel-body">{children}</div></section>;
}
export function PrototypeStat({ label, value, note, tone = "" }: { label: string; value: ReactNode; note: string; tone?: string }) {
  return <div className={`stat ${tone}`}><div className="stat-top"><span>{label}</span></div><div className="stat-value mono">{value}</div><div className="stat-bottom"><span>{note}</span></div></div>;
}
export function PrototypeFacts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="facts">{rows.map(([label, value]) => <div key={label} style={{ display: "contents" }}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function PrototypeTag({ children, tone = "" }: { children: ReactNode; tone?: string }) { return <span className={`tag ${tone}`}>{children}</span>; }
export function PrototypeEmpty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
