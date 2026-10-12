/** 각 원문에서 확인한 대표 조건의 요약. 제품의 라이선스를 이름으로 추정하는 데 쓰지 않는다. */
export const LICENSE_GUIDE = [
  {
    name: "MIT", url: "https://opensource.org/license/mit",
    commercial: "가능", redistribution: "가능",
    source: "소스 제공 의무 없음",
    conditions: "복사본·상당 부분에 저작권·허락 문구 유지",
  },
  {
    name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0",
    commercial: "가능", redistribution: "가능",
    source: "소스 제공 의무 없음",
    conditions: "라이선스·관련 고지·NOTICE 유지, 수정 표시. 특허 허락과 특허 소송 시 종료 조항",
  },
  {
    name: "BSD-2-Clause", url: "https://opensource.org/license/bsd-2-clause",
    commercial: "가능", redistribution: "가능",
    source: "소스 제공 의무 없음",
    conditions: "소스 또는 바이너리의 문서·자료에 저작권·조건·면책 문구 유지",
  },
  {
    name: "BSD-3-Clause", url: "https://opensource.org/license/bsd-3-clause",
    commercial: "가능", redistribution: "가능",
    source: "소스 제공 의무 없음",
    conditions: "BSD-2 조건 + 저작권자·기여자 이름을 허락 없이 홍보·보증에 사용 금지",
  },
  {
    name: "ISC", url: "https://opensource.org/license/isc",
    commercial: "가능", redistribution: "가능",
    source: "소스 제공 의무 없음",
    conditions: "모든 복사본에 저작권·허락 문구 유지",
  },
  {
    name: "GPL-2.0", url: "https://opensource.org/license/gpl-2.0",
    commercial: "가능", redistribution: "GPL 조건으로 가능",
    source: "배포 시 해당 프로그램·파생물의 대응 소스 제공",
    conditions: "GPL로 배포, 저작권·라이선스·변경 고지 유지. 단순 별도 묶음은 적용 범위에서 제외",
  },
  {
    name: "GPL-3.0", url: "https://opensource.org/license/gpl-3.0",
    commercial: "가능", redistribution: "GPL 조건으로 가능",
    source: "배포 시 해당 프로그램·파생물의 대응 소스 제공",
    conditions: "GPL로 배포, 고지·수정 표시. 특허 조항, 해당 소비자 제품에는 수정본 설치 정보도 제공",
  },
  {
    name: "LGPL-2.1", url: "https://opensource.org/license/lgpl-2-1",
    commercial: "가능", redistribution: "LGPL 조건으로 가능",
    source: "라이브러리 배포 시 해당 라이브러리·수정본의 소스 제공",
    conditions: "앱은 다른 라이선스로 연결 가능. 라이브러리 교체·재연결 및 수정 디버깅용 역공학 허용 등 필요",
  },
  {
    name: "LGPL-3.0", url: "https://opensource.org/license/lgpl-3-0",
    commercial: "가능", redistribution: "LGPL 조건으로 가능",
    source: "라이브러리 배포 시 해당 라이브러리·수정본의 소스 제공",
    conditions: "앱은 다른 라이선스로 연결 가능. 교체·재연결·수정 디버깅용 역공학 보장, 해당 제품은 설치 정보 제공",
  },
  {
    name: "MPL-2.0", url: "https://www.mozilla.org/en-US/MPL/2.0/",
    commercial: "가능", redistribution: "MPL 조건으로 가능",
    source: "배포 시 MPL 적용 파일과 그 수정본의 소스 제공",
    conditions: "파일 단위로 MPL 유지·고지. MPL 코드가 없는 별도 파일은 다른 라이선스로 결합 가능",
  },
  {
    name: "AGPL-3.0", url: "https://opensource.org/license/agpl-3.0",
    commercial: "가능", redistribution: "AGPL 조건으로 가능",
    source: "배포 시 대응 소스 제공. 수정본의 원격 사용자에게도 무료 소스 접근 제공",
    conditions: "GPL-3.0과 유사한 배포 조건 + 수정한 프로그램의 네트워크 이용자에게 소스 취득 방법 안내",
  },
  {
    name: "Unlicense", url: "https://unlicense.org/",
    commercial: "가능", redistribution: "가능",
    source: "소스 제공 의무 없음",
    conditions: "저작권을 퍼블릭 도메인에 기증. 법이 허용하는 범위와 원문 확인",
  },
  {
    name: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/legalcode.en",
    commercial: "가능", redistribution: "가능",
    source: "소스 제공 의무 없음",
    conditions: "저작권 등 포기, 효력이 없으면 대체 허락. 특허·상표권은 포함하지 않음",
  },
] as const;

export const GITHUB_LICENSE_GUIDE_URL = "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository";
