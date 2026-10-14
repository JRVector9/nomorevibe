import { describe, expect, it } from "vitest";
import { checkKoreanTagline, isKoreanLine, parseKoreanTaglines } from "@/lib/domain/products/korean-tagline";
import { packTaglineBatch } from "@/lib/jobs/products/korean-tagline";

describe("isKoreanLine — 이미 한국어인 소개는 옮기지 않는다", () => {
  it("한글이 든 낱말이 절반 이상이면 한국어다", () => {
    expect(isKoreanLine("가계부를 쉽게 쓰는 앱")).toBe(true);
    // 영어 고유명사가 섞여도 한국어 소개다 — 글자 수 기준(30%)이면 옮길 글이 됐다
    expect(isKoreanLine("Claude Code용 MCP 서버")).toBe(true);
    expect(isKoreanLine("AI 에이전트용 Next.js·Supabase SaaS 스타터 킷")).toBe(true);
  });
  it("영어·중국어·한글 한두 낱말이 섞인 영어는 옮긴다", () => {
    expect(isKoreanLine("Edit videos locally using FFmpeg")).toBe(false);
    expect(isKoreanLine("水杉输入法")).toBe(false);
    expect(isKoreanLine("Korean BBQ 맛집 finder for Seoul travelers")).toBe(false);
    expect(isKoreanLine("")).toBe(false);
  });
});

describe("checkKoreanTagline — 모델이 옮긴 줄을 그대로 믿지 않는다", () => {
  const ffmpeg = { name: "ffmpeg-studio", tagline: "Edit videos locally using FFmpeg in your browser" };
  const wireshark = { name: "Wireshark", tagline: "Wireshark is the world's foremost network protocol analyzer" };

  it("맞게 옮긴 줄은 다듬어 받는다", () => {
    expect(checkKoreanTagline("브라우저에서 FFmpeg로 동영상을 로컬 편집", ffmpeg)).toEqual({ ok: true, line: "브라우저에서 FFmpeg로 동영상을 로컬 편집" });
    // 감싼 따옴표·끝 마침표·여러 칸 공백을 뗀다
    expect(checkKoreanTagline("  \"Wireshark는  세계 최고의 네트워크 프로토콜 분석기.\" ", wireshark))
      .toEqual({ ok: true, line: "Wireshark는 세계 최고의 네트워크 프로토콜 분석기" });
    // 원문이 풀어 쓴 흔한 약어는 지어낸 말이 아니다
    expect(checkKoreanTagline("터미널에서 쓰는 AI 코드 리뷰 CLI", { name: "revu", tagline: "Artificial intelligence code review from your command line" }).ok).toBe(true);
    // 숫자는 원문에 있으면 된다
    expect(checkKoreanTagline("PDF 10개를 한 번에 합치기", { name: "pdfjoin", tagline: "Merge 10 PDFs at once" }).ok).toBe(true);
    // 글 안의 따옴표는 그대로다 — 통째로 감싼 것만 뗀다
    expect(checkKoreanTagline("'Ogu'로 지출을 기록하는 가계부", { name: "Ogu", tagline: "Track spending with 'Ogu'" }))
      .toEqual({ ok: true, line: "'Ogu'로 지출을 기록하는 가계부" });
  });

  it("빈 줄·여러 줄·링크·마크다운·거절은 버린다", () => {
    expect(checkKoreanTagline("", ffmpeg)).toEqual({ ok: false, reason: "empty" });
    expect(checkKoreanTagline("FFmpeg로 동영상 편집\n브라우저에서", ffmpeg)).toEqual({ ok: false, reason: "multiline" });
    expect(checkKoreanTagline("https://ffmpeg.org 에서 동영상 편집", ffmpeg)).toEqual({ ok: false, reason: "markup" });
    expect(checkKoreanTagline("**FFmpeg**로 동영상 편집", ffmpeg)).toEqual({ ok: false, reason: "markup" });
    expect(checkKoreanTagline("죄송하지만 이 글은 옮길 수 없습니다", ffmpeg)).toEqual({ ok: false, reason: "boilerplate" });
    expect(checkKoreanTagline("번역: 브라우저에서 FFmpeg로 동영상 편집", ffmpeg)).toEqual({ ok: false, reason: "boilerplate" });
  });

  it("길이와 언어를 본다", () => {
    expect(checkKoreanTagline("가".repeat(81), ffmpeg)).toEqual({ ok: false, reason: "too_long" });
    expect(checkKoreanTagline("편집", ffmpeg)).toEqual({ ok: false, reason: "too_short" });
    // 영어를 되돌려 줬다
    expect(checkKoreanTagline("Edit videos locally using FFmpeg in your browser", ffmpeg)).toEqual({ ok: false, reason: "not_korean" });
    // 중국어를 그대로 두었다 — 이름에 있는 한자만 된다
    expect(checkKoreanTagline("水杉 한국어 입력기", { name: "Shuishan", tagline: "水杉输入法 for Linux" })).toEqual({ ok: false, reason: "foreign_script" });
    expect(checkKoreanTagline("水杉输入法 리눅스용 입력기", { name: "水杉输入法", tagline: "水杉输入法 for Linux" }).ok).toBe(true);
  });

  it("원문의 제품 이름을 음역하면 버린다", () => {
    expect(checkKoreanTagline("와이어샤크는 세계 최고의 네트워크 프로토콜 분석기", wireshark)).toEqual({ ok: false, reason: "name_lost" });
    // 원문에 대소문자까지 그대로 있지 않은 흔한 낱말은 옮겨도 된다
    expect(checkKoreanTagline("메모를 빠르게 적고 찾기", { name: "Notes", tagline: "Take notes and find them fast" }).ok).toBe(true);
  });

  it("원문에 없는 숫자·영문 낱말(지어낸 기능·플랫폼)은 버린다", () => {
    expect(checkKoreanTagline("FFmpeg로 동영상 100개를 로컬 편집", ffmpeg)).toEqual({ ok: false, reason: "invented_number" });
    expect(checkKoreanTagline("iOS에서 FFmpeg로 동영상을 로컬 편집", ffmpeg)).toEqual({ ok: false, reason: "invented_term" });
  });

  it("1인칭·3인칭은 숫자로 세지 않는다 — 그 밖의 숫자는 그대로 본다", () => {
    const shooter = { name: "Doodle District", tagline: "Play a ballpoint-style first-person shooter on lined paper and choose your loadout" };
    expect(checkKoreanTagline("줄 공책 위에서 볼펜 낙서풍 1인칭 슈팅 게임을 하고 무기 구성을 고른다", shooter).ok).toBe(true);
    expect(checkKoreanTagline("3인칭 시점으로 줄 공책 위를 누비는 슈팅 게임", shooter).ok).toBe(true);
    expect(checkKoreanTagline("1인칭 슈팅 게임에서 무기 12종을 고른다", shooter)).toEqual({ ok: false, reason: "invented_number" });
  });

  it("원문이 글로 쓴 수·단위는 값으로 맞춘다 — 맞게 옮긴 줄이 버려져 원문으로 남았다(2026-10-14)", () => {
    const ok = (line: string, tagline: string) => expect(checkKoreanTagline(line, { name: "x", tagline }).ok).toBe(true);
    ok("매일 새로운 퍼즐 7가지: 스도쿠, 퀴즈, 체스 등", "Seven fresh puzzles every day: sudoku variants, trivia, chess and more.");
    ok("Pico 2용 3채널 오실로스코프", "PiLyzer — a three-channel oscilloscope for Pico 2");
    ok("향후 8일간의 폐쇄 시간을 알려드립니다", "Closure times for the next eight days.");
    ok("1,500건 자동 검증과 온라인 플랫폼 2개", "Deux plateformes complètes en ligne, 1 500 vérifications automatiques");
    ok("10개가 넘는 시스템을 직접 구축해 운영", "Über zehn Systeme in Produktion, alle allein gebaut");
    ok("로컬 또는 온라인으로 최대 4인까지 플레이", "Jugar al Pac-Man en modo local o online hasta cuatro jugadores");
    ok("6단계 오리지널 네온 미로 게임", "原创霓虹迷宫游戏，六关递进。");
    ok("78장의 타로 카드를 하나씩 풀어 준다", "把问题放下，让七十八张伟特塔罗一张一张说给你听。");
    ok("조사·전략·로드맵, Orion soft 3년 경험", "Исследования, стратегия, roadmap. Три года в Orion soft.");
    ok("제2차 세계대전 동안 한 국가를 지휘", "Command a single nation through World War II");
    ok("1100만 가정이 신뢰하는 아기 활동 계획", "Daily activity plans for your baby. Trusted by 11M+ families.");
    ok("50만 MAU 제품과 85개 이상의 강좌", "85+ курсов, продукт на 500 000 MAU");
    ok("20만 명 이상이 쓰는 플릿 플랫폼", "shipped fleet platforms for 200,000+ users");
    ok("가입자 30만 명", "注册用户30万");
    ok("월 4.99달러/TB 객체 저장소", "S3-compatible object storage. $4.99/TB/month");
  });

  it("값이 다른 수는 그대로 버린다 — 단위가 붙으면 같은 숫자 글자가 있어도 값으로만 본다", () => {
    expect(checkKoreanTagline("85개 이상의 강좌, 1조 원 이상 매출", { name: "x", tagline: "85+ курсов, 1+ млрд ₽ выручки" }))
      .toEqual({ ok: false, reason: "invented_number" });
    expect(checkKoreanTagline("110만 가정이 신뢰", { name: "x", tagline: "Trusted by 11M+ families" })).toEqual({ ok: false, reason: "invented_number" });
    expect(checkKoreanTagline("매일 새로운 퍼즐 8가지", { name: "x", tagline: "Seven fresh puzzles every day" })).toEqual({ ok: false, reason: "invented_number" });
    expect(checkKoreanTagline("10억 루블 이상 매출", { name: "x", tagline: "1+ млрд ₽ выручки" }).ok).toBe(true);
    // 운영에 받아 둔 줄에서 찾은 자릿수 틀림 — 100k 를 100만, 3 crore(3천만)를 3억으로
    expect(checkKoreanTagline("100만+ 상품을 50ms 이하로 필터링", { name: "x", tagline: "sub-50ms filters on 100k+ products" }))
      .toEqual({ ok: false, reason: "invented_number" });
    expect(checkKoreanTagline("직원에게 월 3억 루피 이상 지급", { name: "x", tagline: "Now disbursing Rs 3 Cr+ a month to employees" }))
      .toEqual({ ok: false, reason: "invented_number" });
    expect(checkKoreanTagline("직원에게 월 3천만 루피 이상 지급", { name: "x", tagline: "Now disbursing Rs 3 Cr+ a month to employees" }).ok).toBe(true);
  });

  it("단위 글자가 '뿐'·'조항'일 때는 원문에 단위 없이 적힌 같은 숫자로 받는다", () => {
    expect(checkKoreanTagline("텍스트 선택 후 ⌘⇧1만 누르면 오타를 고친다", { name: "x", tagline: "Select text, press ⌘⇧1, review the edit, done." }).ok).toBe(true);
    expect(checkKoreanTagline("로컬 CLI v0.7.0만 제공", { name: "x", tagline: "Local CLI v0.7.0 is the admitted artifact" }).ok).toBe(true);
    expect(checkKoreanTagline("EU CRA 제14조 보고 시계 제공", { name: "x", tagline: "the EU CRA Article 14 reporting clock" }).ok).toBe(true);
  });
});

describe("parseKoreanTaglines", () => {
  it("개수가 맞는 문자열 배열만 받는다", () => {
    expect(parseKoreanTaglines('<think>음</think>["하나", "둘"]', 2)).toEqual({ ok: true, outputs: ["하나", "둘"] });
    expect(parseKoreanTaglines('["하나", 3]', 2)).toEqual({ ok: true, outputs: ["하나", ""] });
    expect(parseKoreanTaglines('["하나"]', 2)).toEqual({ ok: false, error: "invalid_output" });
    expect(parseKoreanTaglines("하나, 둘", 2)).toEqual({ ok: false, error: "invalid_output" });
  });
});

describe("packTaglineBatch", () => {
  const task = (productId: number, tagline: string, attempts = 0) => ({ productId, name: `p${productId}`, tagline, repoUrl: null, attempts });
  it("차례대로 8건·1,200자까지 묶는다", () => {
    expect(packTaglineBatch(Array.from({ length: 12 }, (_, i) => task(i, "x".repeat(50)))).map((t) => t.productId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(packTaglineBatch([task(1, "x".repeat(200)), ...Array.from({ length: 8 }, (_, i) => task(i + 2, "y".repeat(190)))]).map((t) => t.productId))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("여러 번 실패한 소개는 혼자 보내고, 묶음에는 끼우지 않는다", () => {
    expect(packTaglineBatch([task(1, "a", 2), task(2, "b")]).map((t) => t.productId)).toEqual([1]);
    expect(packTaglineBatch([task(1, "a"), task(2, "b", 3), task(3, "c")]).map((t) => t.productId)).toEqual([1, 3]);
  });
});
