/**
 * vitest 용 next/font/google — 진짜 글꼴 함수는 Next 컴파일러(SWC)가 빌드 때 바꿔 넣는 것이라 그대로 부르면 없다.
 * 시험은 글꼴 파일이 아니라 화면 구조를 보므로 빈 클래스·변수를 돌려준다.
 */
type FontResult = { className: string; variable: string; style: { fontFamily: string } };
const font = (): FontResult => ({ className: "", variable: "", style: { fontFamily: "" } });
export const IBM_Plex_Sans_KR = font;
export const IBM_Plex_Mono = font;
