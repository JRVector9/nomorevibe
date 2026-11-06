import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SearchModelConstraints } from "@/app/(operator)/admin/models/SearchModelConstraints";

it("임베딩 벡터 공간과 미확인 재정렬 모델을 숨기거나 임의 변경하지 않는다", () => {
  const html = renderToStaticMarkup(createElement(SearchModelConstraints, { health: [], embeddingModel: "fixture-embedding@hash", dimensions: 1024 }));
  for (const text of ["의미 검색 임베딩", "fixture-embedding@hash", "1024", "검색 결과 재정렬", "모델 식별자 미확인", "연결 환경 미설정"]) expect(html).toContain(text);
  expect(html).not.toContain("추가·제거·저장 보류");
  expect(html).toContain('href="/admin/models/search"');
  expect(html).toContain("검색 모델 설정 열기");
  expect(html).toContain("제품·검색어 벡터 API는 함께 설정하고 기존 벡터 32개와 호환성을 확인합니다. 재정렬은 저장할 때 응답을 확인합니다.");
  expect(html).not.toContain("<button"); expect(html).not.toContain("<select");
});
it("서버 건강 응답을 개별 모델 호출 성공으로 표시하지 않는다", () => {
  const html = renderToStaticMarkup(createElement(SearchModelConstraints, { health: [{ name: "임베딩", ok: true }, { name: "재정렬", ok: false, error: "HTTP 503" }], embeddingModel: "fixture", dimensions: 1024 }));
  expect(html).toContain("서버 /health 응답 확인"); expect(html).toContain("서버 확인 실패 · HTTP 503");
  expect(html).toContain("서버 상태는 /health 또는 모델 목록 응답 기준입니다."); expect(html).not.toContain("모델 호출 성공");
});
