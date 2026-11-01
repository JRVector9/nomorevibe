"use client";

import { useState } from "react";
import { buttonDashed, buttonQuiet } from "./Switch";

type Model = { provider: string; model: string };
export type ModelOption = Model & { label: string };

const PROVIDERS = [
  { value: "local-direct", label: "모델 서버 직접 연결" },
  { value: "abcllm", label: "abcllm · 직접 연결 계약" },
  { value: "claude-cli", label: "Claude CLI" },
  { value: "grok-cli", label: "Grok CLI" },
];

/**
 * 2차 심사의 표·대체 모델 — 세운 것만 보이고, 비어 있는 칸은 "더하기"로 연다.
 * 이름은 예전과 같다(`${prefix}Provider0`·`${prefix}Model0` …). 모델을 비운 칸은 서버가 세우지 않는다.
 * readOnly(배정 표로 옮겨진 뒤, PR 3b-D)면 지금 값을 글자로 보이고 같은 이름의 숨은 칸으로 그대로 보낸다 — 다른 칸을 저장해도 이 값은 바뀌지 않는다.
 */
export function ModelRows({ prefix, initial, max, addLabel, placeholder, choices = [], allowDirect = true, readOnly = false }: {
  prefix: "primary" | "firstAdditional" | "voter" | "fallback"; initial: Model[]; max: number; addLabel: string; placeholder: string;
  choices?: readonly ModelOption[];
  allowDirect?: boolean;
  readOnly?: boolean;
}) {
  // 값을 상태로 든다 — 가운데 칸을 빼면 아래 칸들이 한 칸씩 당겨지는데, 손대지 않는 입력이면 고친 값이 사라진다
  const [rows, setRows] = useState<Model[]>(() => initial.slice(0, max));
  if (readOnly) return <div className="flex flex-col gap-2" data-readonly="true">
    {rows.length === 0 && <span className="text-[13px] text-fg-3">없음</span>}
    {rows.map((row, index) => <div key={index} className="flex flex-wrap items-center gap-2 rounded-[9px] border border-line bg-bg-soft px-2.5 py-2 text-[13px]">
      <input type="hidden" name={`${prefix}Provider${index}`} value={row.provider} />
      <input type="hidden" name={`${prefix}Model${index}`} value={row.model} />
      <span className="font-semibold">{PROVIDERS.find(provider => provider.value === row.provider)?.label ?? row.provider}</span>
      <code className="min-w-0 break-all">{row.model}</code>
    </div>)}
  </div>;
  const change = (index: number, patch: Partial<Model>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 rounded-[9px] border border-line px-2.5 py-2">
          {choices.length > 0 && <select aria-label={`${index + 1}번째 모델 목록에서 선택`}
            value={choices.findIndex(choice => choice.provider === row.provider && choice.model === row.model)}
            onChange={event => {
              const choice = choices[Number(event.target.value)];
              if (choice) change(index, { provider: choice.provider, model: choice.model });
            }} className="w-full rounded-md border border-line bg-bg-hover px-2 py-1 text-[13px]">
            <option value={-1}>직접 입력 · 현재 값 유지</option>
            {choices.map((choice, at) => <option key={`${choice.provider}|${choice.model}`} value={at}>{choice.label}</option>)}
          </select>}
          <select name={`${prefix}Provider${index}`} value={row.provider} onChange={(event) => change(index, { provider: event.target.value })}
            aria-label={`${index + 1}번째 부르는 곳`}
            className="rounded-md border border-transparent bg-bg-hover px-2 py-1 text-[13px] font-semibold outline-none hover:border-line focus:border-accent">
            {PROVIDERS.filter(provider => allowDirect || provider.value !== "local-direct").map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
          </select>
          <input name={`${prefix}Model${index}`} value={row.model} onChange={(event) => change(index, { model: event.target.value })}
            aria-label={`${index + 1}번째 모델`} placeholder={placeholder}
            className="min-h-[32px] min-w-0 flex-[1_1_200px] rounded-[7px] border border-transparent bg-transparent px-2 py-1 font-mono text-[13px] text-fg outline-none hover:border-line focus:border-accent" />
          <button type="button" className={`${buttonQuiet} ml-auto`}
            onClick={() => setRows((current) => current.filter((_, at) => at !== index))} aria-label={`${index + 1}번째 모델 빼기`}>빼기</button>
        </div>
      ))}
      {rows.length < max && (
        <button type="button" className={buttonDashed}
          onClick={() => setRows((current) => [...current, { provider: "abcllm", model: "" }])}>{addLabel}</button>
      )}
    </div>
  );
}
