/** Generic Qwen task instructions from the frozen v2.1 comparison; no reference answers or case examples. */
export const QWEN_TRANSLATION_PROMPT_VERSION = "translation-model-prompts-2026-10-23.v2.1";
export const QWEN_TRANSLATION_PROMPT_SNAPSHOT_SHA256 = "f69eda4399091ff2c3d9806cb565c6493e8d2f44fdf31af8639274e7214eb6fb";

type TranslationTask = "product-translate" | "product-tagline-ko";
const QWEN_SUFFIXES: Record<TranslationTask, string> = {
  "product-translate": "OUTPUT CONTRACT (mandatory): Input is one array containing {count} independent items. The entire response must be exactly one JSON array of {count} plain strings. Each response element i is the translation of input item i. A string must not contain a serialized array. Do NOT wrap the output array in another array, and do NOT return an object or a separate array per item. No code fences, headers, explanation or reasoning. Follow each item's locale independently: en English, zh-Hans natural Simplified Chinese, zh-Hant natural Traditional Chinese with Taiwanese software terms. Translate all source meaning and keep negation, conditions, uncertainty and feature scope; do not omit a qualifier to make the text smoother. Keep product/company/technology names, numbers, URLs and quoted citations verbatim. A brand name or an ambiguous fragment must not be expanded with guessed facts just to form a sentence. Only target-language prose changes. Before emitting, silently verify {count} string elements in original order and then stop after the closing square bracket. If the source ends mid-word or mid-sentence, preserve that incomplete scope; do not invent a continuation.",
  "product-tagline-ko": "출력 형식: 입력은 {count}개 항목으로 된 배열 하나다. 답변 전체는 정확히 {count}개 문자열이 든 JSON 배열 하나여야 한다. 각 원소는 해당 순서의 한국어 소개 문자열이다. 배열을 다시 배열로 감싸지 말고, 원소마다 별도 배열이나 객체를 만들지 않는다. 코드 블록·제목·설명·추론을 쓰지 않는다. 각 소개는 50~65자를 목표로 하고 공백·영문 이름을 합쳐 반드시 80자 이하다. 긴 원문은 표현을 압축하되 핵심 기능, 중요한 조건·부정·불확실성·숫자는 바꾸지 않는다. 원문에 없는 기능·플랫폼·칭찬을 추가하지 않는다. 제품·회사·기술 이름은 원래 표기를 유지하고 한글 음역으로 바꾸지 않는다. 조사를 연결해 자연스러운 한국어 한 줄로 쓰며 끝 마침표를 붙이지 않는다. 출력 직전에 개수·원래 순서·80자 상한·이름·숫자를 내부 점검하고 닫는 대괄호 뒤에는 아무것도 쓰지 않는다.",
};

/** GPT-OSS and unknown models retain their original systems; only Qwen uses the frozen experiment's task suffix. */
export function translationSystemPrompt(base: string, task: TranslationTask, model: string, count: number): string {
  const name = model.trim().replace(/^\[[^\]]+\]\s*/, "").split("/").at(-1) ?? "";
  return /^qwen(?:\d|[-_]|$)/i.test(name)
    ? `${base}\n\n${QWEN_SUFFIXES[task].replaceAll("{count}", String(count))}`
    : base;
}
