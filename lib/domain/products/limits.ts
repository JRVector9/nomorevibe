/**
 * 입력 길이 상한 — DB 비대와 상세 페이지 수 MB 렌더를 막는다.
 * schema.ts 에서 떼어 둔다: schema.ts 는 URL 검사로 node:net 을 불러, 브라우저 컴포넌트(관리자 소개 고치기 입력칸)가 가져오면 빌드가 깨진다.
 */
export const LIMITS = {
  name: 120,
  tagline: 200,
  description: 4000,
  builder: 60,
  makerName: 120,
  repoUrl: 500,
  stackItems: 12,
  stackItemLength: 40,
} as const;
