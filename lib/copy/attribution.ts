/** 상세 응답을 내보낼 때만 출처를 붙인다. 저장된 소개·번역은 바꾸지 않는다. */
export function detailMetaDescription(text: string): string {
  const suffix = " · nomorevibe.com";
  const value = text.trimEnd();
  return value.endsWith(suffix) ? value : `${value}${suffix}`;
}

export function attributedIntroduction(text: string, sourceLine: string): string {
  const value = text.trimEnd();
  return value.endsWith(sourceLine) ? value : `${value}\n\n${sourceLine}`;
}
