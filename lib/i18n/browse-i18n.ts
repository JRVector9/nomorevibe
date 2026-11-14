import { browse } from "@/messages/ko/browse";
import { detail } from "@/messages/ko/detail";
import { labels } from "@/messages/ko/labels";
import type { Locale } from "./locales";
import { createTranslator, type Translator } from "./messages";

/**
 * 서버가 그리는 홈·목록 구획(필터 줄·소개 줄·도구·활발한·소식)이 받는 언어와 번역기.
 *
 * 이 구획들은 2026-11-14 공개 HTML 줄이기로 브라우저 부품에서 서버 부품이 됐다 — 브라우저 부품이면 집계·목록 값이
 * RSC 데이터에 JSON 으로 한 번 더 실렸다. 화면은 요청 언어의 번역기를 넘기고, 넘기지 않으면 기본 언어(한국어)로 그린다.
 */
export type BrowseI18n = { locale: Locale; t: Translator<"browse">; labels: Translator<"labels"> };

export const KOREAN_BROWSE_I18N: BrowseI18n = {
  locale: "ko",
  t: createTranslator("browse", browse),
  labels: createTranslator("labels", labels),
};

/** 상세 머리(서버 부품)의 언어와 번역기 — 없으면 기본 언어(한국어) */
export type DetailI18n = { locale: Locale; t: Translator<"detail">; labels: Translator<"labels"> };

export const KOREAN_DETAIL_I18N: DetailI18n = {
  locale: "ko",
  t: createTranslator("detail", detail),
  labels: KOREAN_BROWSE_I18N.labels,
};
