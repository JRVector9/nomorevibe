/**
 * 통합 테스트 전용 DB 주소. 개발 DB 가 아니라 전용 DB(기본 포트 55435)를 쓴다.
 * globalSetup(DB 연결 모듈을 올리지 않는다)과 setup.ts 가 함께 읽도록 따로 둔다.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_test";
