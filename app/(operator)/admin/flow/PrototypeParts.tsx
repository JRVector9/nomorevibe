import { Fragment, type ReactNode } from "react";

export const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("ko-KR");
export const clock = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "확인 못함";
export function Tag({ children, tone = "" }: { children: ReactNode; tone?: string }) { return <span className={`tag ${tone}`}>{children}</span>; }
export function ReadStamp({ at }: { at?: string | null }) { return <span className={`read-stamp ${at ? "" : "stale"}`}>{at ? `● 관측 ${clock(at)} KST` : "? 관측을 읽지 못함"}</span>; }
export function Stat({ label, value, foot, tone = "", spark }: { label: string; value: ReactNode; foot: ReactNode; tone?: string; spark?: number[] | null }) {
  return <div className={`stat ${tone}`}><div className="stat-top"><span>{label}</span><Tag>실측</Tag></div><div className="stat-value mono">{value}</div><div className="stat-bottom"><span>{foot}</span><PrototypeSpark values={spark} label={`${label} 시간별 추이`} /></div></div>;
}
export function PrototypeSpark({ values, label }: { values?: readonly number[] | null; label: string }) {
  if (!values?.length) return null;
  const max = Math.max(1, ...values), points = values.map((value, index) => `${index ? "L" : "M"}${(index * 85 / Math.max(1, values.length - 1)).toFixed(1)},${(22 - value / max * 20).toFixed(1)}`).join(" ");
  return <svg className="spark" viewBox="0 0 85 24" role="img" aria-label={label}><path className="area" d={`${points} L85,24 L0,24 Z`} /><path d={points} /></svg>;
}
export function Panel({ title, description, tool, children, note, id, flush = false }: { title: ReactNode; description?: ReactNode; tool?: ReactNode; children: ReactNode; note?: ReactNode; id?: string; flush?: boolean }) {
  return <section className="panel" id={id}><div className="panel-head"><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{tool && <div className="right">{tool}</div>}</div>{flush ? children : <div className="panel-body">{children}</div>}{note && <div className="panel-foot">{note}</div>}</section>;
}
export function Facts({ rows }: { rows: [string, ReactNode][] }) { return <dl className="facts">{rows.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>; }
export function DataTable({ heads, children, note, min = 850 }: { heads: string[]; children: ReactNode; note?: ReactNode; min?: number }) {
  return <><div className="table-scroll"><table style={{ minWidth: min }}><thead><tr>{heads.map(head => <th key={head} scope="col">{head}</th>)}</tr></thead><tbody>{children}</tbody></table></div>{note && <div className="table-note">{note}</div>}</>;
}
