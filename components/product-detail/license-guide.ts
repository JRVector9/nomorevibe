/** 각 원문에서 확인한 대표 조건의 요약. 제품의 라이선스를 이름으로 추정하는 데 쓰지 않는다. */
export const LICENSE_GUIDE = [
  {
    name: "MIT", url: "https://opensource.org/license/mit",
    commercial: "license.allowed", redistribution: "license.allowed",
    source: "license.source.none",
    conditions: "license.condition.mit",
  },
  {
    name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0",
    commercial: "license.allowed", redistribution: "license.allowed",
    source: "license.source.none",
    conditions: "license.condition.apache",
  },
  {
    name: "BSD-2-Clause", url: "https://opensource.org/license/bsd-2-clause",
    commercial: "license.allowed", redistribution: "license.allowed",
    source: "license.source.none",
    conditions: "license.condition.bsd2",
  },
  {
    name: "BSD-3-Clause", url: "https://opensource.org/license/bsd-3-clause",
    commercial: "license.allowed", redistribution: "license.allowed",
    source: "license.source.none",
    conditions: "license.condition.bsd3",
  },
  {
    name: "ISC", url: "https://opensource.org/license/isc",
    commercial: "license.allowed", redistribution: "license.allowed",
    source: "license.source.none",
    conditions: "license.condition.isc",
  },
  {
    name: "GPL-2.0", url: "https://opensource.org/license/gpl-2.0",
    commercial: "license.allowed", redistribution: "license.gplAllowed",
    source: "license.source.gpl",
    conditions: "license.condition.gpl2",
  },
  {
    name: "GPL-3.0", url: "https://opensource.org/license/gpl-3.0",
    commercial: "license.allowed", redistribution: "license.gplAllowed",
    source: "license.source.gpl",
    conditions: "license.condition.gpl3",
  },
  {
    name: "LGPL-2.1", url: "https://opensource.org/license/lgpl-2-1",
    commercial: "license.allowed", redistribution: "license.lgplAllowed",
    source: "license.source.lgpl",
    conditions: "license.condition.lgpl2",
  },
  {
    name: "LGPL-3.0", url: "https://opensource.org/license/lgpl-3-0",
    commercial: "license.allowed", redistribution: "license.lgplAllowed",
    source: "license.source.lgpl",
    conditions: "license.condition.lgpl3",
  },
  {
    name: "MPL-2.0", url: "https://www.mozilla.org/en-US/MPL/2.0/",
    commercial: "license.allowed", redistribution: "license.mplAllowed",
    source: "license.source.mpl",
    conditions: "license.condition.mpl",
  },
  {
    name: "AGPL-3.0", url: "https://opensource.org/license/agpl-3.0",
    commercial: "license.allowed", redistribution: "license.agplAllowed",
    source: "license.source.agpl",
    conditions: "license.condition.agpl",
  },
  {
    name: "Unlicense", url: "https://unlicense.org/",
    commercial: "license.allowed", redistribution: "license.allowed",
    source: "license.source.none",
    conditions: "license.condition.unlicense",
  },
  {
    name: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/legalcode.en",
    commercial: "license.allowed", redistribution: "license.allowed",
    source: "license.source.none",
    conditions: "license.condition.cc0",
  },
] as const;

export const GITHUB_LICENSE_GUIDE_URL = "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository";
