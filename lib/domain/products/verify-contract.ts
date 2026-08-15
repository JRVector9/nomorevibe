// 도메인 검증 규약 — 등록 응답(201)과 검증 실패 응답(422), 스킬 안내가 같은 정의를 쓴다
export const VERIFY_FILE_PATH = "/.well-known/nomorevibe.txt";
export const VERIFY_META_NAME = "nomorevibe-verify";

export function verifyExpectation(verifyToken: string) {
  return {
    file: { path: VERIFY_FILE_PATH, content: verifyToken },
    meta: { tag: `<meta name="${VERIFY_META_NAME}" content="${verifyToken}">` },
  };
}

export function verifyInstructions(origin: string, verifyToken: string, slug: string) {
  return {
    ...verifyExpectation(verifyToken),
    verify_endpoint: `${origin}/api/products/${slug}/verify`,
  };
}
