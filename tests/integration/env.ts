import { TEST_DATABASE_URL } from "./setup";

// lib/db는 첫 쿼리 시점에 초기화되므로, import 순서와 무관하게 여기서 지정하면 된다
process.env.DATABASE_URL = TEST_DATABASE_URL;

// 통합 테스트는 외부 fetch를 목킹하므로 SSRF 가드의 DNS 조회를 태울 이유가 없다.
// 가드 자체는 tests/ssrf.test.ts가 실제 네트워크로 검증한다.
process.env.ALLOW_PRIVATE_URLS = "1";

// 테스트 출력에 로그가 섞이지 않도록
process.env.LOG_LEVEL = "error";
