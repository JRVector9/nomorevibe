import { NextResponse } from "next/server";
import type { DomainError } from "@/lib/domain/products/errors";

/** 도메인 실패 사유 → HTTP 응답. 매핑을 한 곳에 모아 라우트마다 어긋나지 않게 한다. */
export function errorResponse(error: DomainError, context?: { origin?: string }): NextResponse {
  switch (error.kind) {
    case "invalid":
      return NextResponse.json({ error: error.message }, { status: 400 });

    case "unreachable":
      return NextResponse.json({ error: error.message }, { status: 422 });

    case "duplicate":
      return NextResponse.json(
        {
          error: "이미 등록된 URL입니다",
          already_registered: true,
          slug: error.slug,
          status: error.status,
          /**
           * seeded는 우리가 대신 올린 제품이라 아무도 수정 키를 갖고 있지 않다.
           * 수정하라고 안내하면 메이커는 있지도 않은 키를 찾게 된다 — 가져가는 길을 알려준다.
           */
          hint: !error.slug
            ? undefined
            : error.status === "seeded"
              ? `우리가 대신 올린 제품입니다. POST /api/products/${error.slug}/verify 로 도메인을 증명하면 가져갈 수 있습니다`
              : `수정하려면 PATCH /api/products/${error.slug} 를 X-Edit-Token 헤더와 함께 호출하세요`,
        },
        { status: 409 },
      );

    case "not_found":
      return NextResponse.json({ error: "제품을 찾을 수 없습니다" }, { status: 404 });

    case "unauthorized":
      return NextResponse.json({ error: error.message }, { status: 401 });

    case "forbidden":
      return NextResponse.json({ error: error.message }, { status: 403 });

    case "verification_failed":
      return NextResponse.json(
        {
          status: "unverified",
          error: "검증 파일 또는 메타태그를 찾을 수 없습니다. 배포가 완료됐는지 확인해주세요.",
          expected: error.expected,
        },
        { status: 422 },
      );
  }
  void context;
}

export const tooManyRequests = () =>
  NextResponse.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." }, { status: 429 });

export const badJson = () => NextResponse.json({ error: "잘못된 JSON 본문입니다" }, { status: 400 });
