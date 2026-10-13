/**
 * 내보내기 CSV — 엑셀이 한글을 깨뜨리지 않고, 셀이 수식으로 실행되지 않게.
 *
 * - 맨 앞 BOM(U+FEFF): 없으면 엑셀이 UTF-8 을 시스템 코드 페이지로 읽어 한글이 깨진다.
 * - 따옴표·쉼표·줄바꿈이 든 셀은 큰따옴표로 감싸고 안의 큰따옴표는 두 번 쓴다(RFC 4180). 줄은 CRLF.
 * - 수식 주입: = + - @ (와 탭·CR)로 시작하는 글자 셀은 앞에 '를 붙여 글자로 둔다. 제품 이름·AI 사유·요청 사유는
 *   바깥 사람이 쓴 글이라 "=HYPERLINK(...)" 같은 것이 들어올 수 있다(OWASP CSV Injection). 숫자 셀은 건드리지 않는다.
 */
export const CSV_BOM = "﻿";

const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 머리 한 줄 + 행. 행은 열 순서대로 값을 꺼낸다 */
export function toCsv<Row>(columns: readonly { label: string; value: (row: Row) => CsvValue }[], rows: readonly Row[]): string {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(","));
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}
